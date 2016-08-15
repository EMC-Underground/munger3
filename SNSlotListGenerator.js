
/***************************************************************************************************************
****************************************************************************************************************
Generates a list of serial numbers that can then be copied into the Alexa Skill Interaction Model
under the 'SN' custom slot
/***************************************************************************************************************
****************************************************************************************************************/

var AWS = require( "aws-sdk" ),
	ECS = require( "aws-sdk" ),
	async = require( "async" );
		
// setup ECS config to point to Bellevue lab 
var ECSconfig = {
  s3ForcePathStyle: true,
  endpoint: new AWS.Endpoint('http://10.4.44.125:9020')
};
ECS.config.loadFromPath(__dirname + '/ECSconfig.json');
var ecs = new ECS.S3(ECSconfig);

var ecsBucket = 'pacnwinstalls',
	awsBucket = 'munger-insights';

// setup s3 config
AWS.config.loadFromPath(__dirname + '/AWSconfig.json');
var s3 = new AWS.S3();

var masterListOfSNs = [];

console.log('starting cycleThru...');
cycleThru();

// This is the master function that calls the 3 supporting functions in series to
// 1) get the list of GDUNS, 2) process each one and 3) write the master list of extracted serial numbers out to a file
function cycleThru() {	
	var customerListSource = 'PNWandNCAcustomers.json',
		GDUNarray = [];

    async.series([
        // get customer GDUN list from ECS object store
        function(callback) {
			console.log('entering async.series 1 function');
            getCustomerList(customerListSource, function(err, GDUNS) {						
                if (err) return callback(err); // return prevents a double callback with process continuing 
				GDUNarray = GDUNS;
				callback(); // this is the callback saying this function is complete
            });
        },
		
        // get install base data for each gdun and extract the serial numbers for each
        function(callback) {
			console.log('entering async.series 2 function');
            processGDUN(GDUNarray, function(err) {             
				if (err) {
					callback(err);
				} else {
					callback(); // this is the callback saying this function is complete
				}			
            });
        },

		// Store the resulting SN list in ECS
		function(callback) {
			storeSNList(masterListOfSNs, function(err, eTag) {
				if (err) return callback(err); // task callback saying this function is complete but with an error, return prevents double callback
				callback(); // this is the task callback saying this function is complete;
			});
		}			
		
		
    ], function(err) {		
		//restart the whole cycle again from the top after wait time
		console.log('Process Complete.');
    });
}

// This function gets the master list of customer GDUNs from the ECS repo.
// It returns that list as the 'GDUNS' array.
function getCustomerList(source, callback) {
	console.log('entering getCustomerList function');
	// get json data object from ECS bucket	
	var GDUNS = [];
	var params = {
			Bucket: ecsBucket,
			Key: source
	};  
	  
	ecs.getObject(params, function(err, data) {
		if (err) {
			callback(err, null); // this is the callback saying getCustomerList function is complete but with an error
		} else { // success					
			console.log(data.Body.toString()); // note: Body is outputted as type buffer which is an array of bytes of the body, hence toString() 
			var dataPayload = JSON.parse(data.Body);
			
			// load GDUNS array
			for (var i = 0; i < dataPayload.length; i++) {
				GDUNS.push(dataPayload[i].gduns);
			}
			
			// free up memory
			data = null; // 
			dataPayload = null;
			
			callback(null, GDUNS)  // this is the callback saying getCustomerList function is complete
		}
	});
}
		
// This function iterates through all of the customer GDUNs, gets IB data for each, and adds the SNs to a master list
function processGDUN(GDUNlist, callback) {
	async.forEachSeries(GDUNlist, function(gdun, callback) {
		var SNsToAdd;

		async.series([
		
			// Pull install base data from ECS 
			function(callback) {
				getIBdata(gdun, function(err, SNarray) {
					if (err) {
						console.log('Error getting install base data for GDUN=' + gdun + ': ' + err);
						callback(err); // this is the task callback saying this function is complete but with an error;	
					} else {
						SNsToAdd = SNarray;
						//console.log('type of SNsToAdd = ' + typeof(SNsToAdd));
						callback(); // this is the task callback saying this function is complete;					
					}
				});
			},
			
			// Add the array of SNs from that GDUN to the master list
			function(callback) {
				addSNsToList(SNsToAdd, function(err) {
					if (err) return callback(err); // task callback saying this function is complete but with an error, return prevents double callback
					callback(); // this is the task callback saying this function is complete;
				});
			}					
			
		], function(err) { // this function gets called after the two tasks have called their "task callbacks"
			if (err) {
				callback(err); // this is the callback saying this run-thru of the series is complete for a given gdun in the async.forEach but with error
			} else {
				callback(); // this is the callback saying this run-thru of the series is complete for a given gdun in the async.forEach 				
			}
		});						
	
	}, 	function(err) {
			if (err) return callback(err);
			callback(); // this is the callback saying all items in the async.forEach are completed
	});
}	

// This function pulls the install base data for a given GDUN, calls the function to extract the SNs, and then provides the SNs 
// in a callback to the calling function.
function getIBdata(gdun, callback) {
	console.log('entering getIBdata function');
	console.log('GDUN = ' + gdun);
	var key = gdun + '.json';

	// get json data object from ECS bucket
	var params = {
			Bucket: ecsBucket,
			Key: key
	};	  
	  
	ecs.getObject(params, function(err, data) {
		if (err) {
			callback(err); 
		} else { // install base data was successfully loaded, so now get insight from data	
			//console.log(data.Body.toString()); // note: Body is outputted as type buffer which is an array of bytes of the body, hence toString() 
			
			try {
				
				var dataPayload = JSON.parse(data.Body) // converts data.Body to a string replacing the array of bytes
				//console.log('dataPayload = ' + dataPayload);
				var payloadObject = JSON.parse(dataPayload); // converts data.Body back to an object 
				console.log('payloadObject.records = ' + payloadObject.records)
				if (payloadObject.records < 1) {
					callback('no JSON payload in ' + key);
				} else {	
					extractSNs(payloadObject, function(SNs)	{			 
						data = null; // free up memory
						dataPayload = null; // free up memory
						//console.log('SNs = ' + JSON.stringify(SNs));
						callback(null, SNs); // this is the  callback saying this getIBdata function is complete;
					})						
				}												
			} catch (e) {
				callback('unexpected install base JSON format in ' + key);
			}
		}
	});	
}

// This function stores the SN master list to a file
function storeSNList(listToStore, callback) {
	var fs = require('fs');
	
	fs.writeFile(__dirname + '/allSNs.txt', listToStore, function(err) {
		if (err) {
			return console.log(err);
		}		
	});

	console.log("The file was saved as allSNs.txt in the local directory.");
	console.log("The total SN count is: " + listToStore.length);
}

// This function returns the SNs from this IB data to the calling function
function extractSNs(installBaseData, callback) {
	console.log('entering extractSNs function');
	
	var	SNs = [] // a list of serial numbers
	//console.log('installBaseData.rows.length = ' + installBaseData.rows.length)
	
	for (var i = 0; i < installBaseData.rows.length; i++) {
		//console.log('installBaseData.rows[i].ITEM_SERIAL_NUMBER = ' + installBaseData.rows[i].ITEM_SERIAL_NUMBER);
		SNs.push( installBaseData.rows[i].ITEM_SERIAL_NUMBER )
	}	
	
	installBaseData = null; // free up memory
	//console.log('SNs = ' + JSON.stringify(SNs));
	callback(SNs);
}

// This function adds the list of SNs from a given GDUN to the master SN list
function addSNsToList(SNsToAdd, callback) {
	console.log('entering addSNsToList function');

	try {
		
		console.log('SNsToAdd.length = ' + SNsToAdd.length)
		
		for (var i = 0; i < SNsToAdd.length; i++) {
			//console.log('SNsToAdd[i] = ' + SNsToAdd[i]);
			
			var needle = SNsToAdd[i];
			var index = contains.call(masterListOfSNs, needle); // true if item is already in masterListOfSNs

			// only add the SN to the master list if it isn't already there
			if (!index) {
				masterListOfSNs.push( SNsToAdd[i] )
			}	
		}	
		
		//console.log('masterListOfSNs = ' + JSON.stringify(masterListOfSNs));
		callback();
		
	} catch (e) {
		callback('problem in adding SNs for GDUN to the master list');
	}	
	
}

// a function to determine if an item in in an array
var contains = function(needle) {
    // Per spec, the way to identify NaN is that it is not equal to itself
    var findNaN = needle !== needle;
    var indexOf;

    if(!findNaN && typeof Array.prototype.indexOf === 'function') {
        indexOf = Array.prototype.indexOf;
    } else {
        indexOf = function(needle) {
            var i = -1, index = -1;

            for(i = 0; i < this.length; i++) {
                var item = this[i];

                if((findNaN && item !== item) || item === needle) {
                    index = i;
                    break;
                }
            }

            return index;
        };
    }

    return indexOf.call(this, needle) > -1;
};
