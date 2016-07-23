
/***************************************************************************************************************
****************************************************************************************************************
This is a microservice that extracts insights about the EMC install base from data originating from Ops Console.
It runs continuously, hosted on Pivotal Cloud Foundry. Every 24 hours it queries the Elastic Cloud Storage (ECS)
object store which hosts EMC field inventory info in JSON format. It then:
- Pulls the current master list of customer GDUNs from the ECS repo.
- Iterates through through all of the customer GDUNs.
- For each customer GDUN, it pulls the install base data from ECS and:
  builds a mapping array of each product serial number to a corresponding SO number.
- It then stores the result in a sanitized JSON format in s3.
The result is a list of objects (number of objects = number of GDUNS x number products at each GDUN) stored in s3.
The name format used is <GDUN>.SNSO.3 (The .3 indicates this is a munger3 insight)
The insight is stored under <GDUN>.SNSO.3.answer
The objects can then be queried by front end apps like an Alexa Skill to return answers to questions like:
'What is the SO number for serial number XYZ at Expedia?'
/***************************************************************************************************************
****************************************************************************************************************/


/***************************************************************************************************************/
	mungerNumber = "3"		// Put the munger number here
/***************************************************************************************************************/

//START OF BOILERPLATE CODE
/****************************************************************************************************************
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

// launch the Munger1 process
console.log('starting cycleThru...');
cycleThru();

// This is the master function that calls the 2 supporting functions in series to
// 1) get the list of GDUNS and then 2) process each one
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
		
        // get install base data for each gdun, extract insight, and post to s3
        function(callback) {
			console.log('entering async.series 2 function');
            processGDUN(GDUNarray, function(err) {             
				if (err) {
					callback(err);
				} else {
					callback(); // this is the callback saying this function is complete
				}			
            });
        }
		
    ], function(err) {		
		//restart the whole cycle again from the top after wait time
		setTimeout(function() {
			cycleThru();
		}, 86400000); // 86400000 = loop through 1 every 24 hours			
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

		
// This function iterates through all of the customer GDUNs,
// pulling the install base data from ECS for each GDUN, mapping the SO number to each corresponding product serial number
// It then stores the result in a sanitized JSON format in s3.	
function processGDUN(GDUNlist, callback) {
	async.forEachSeries(GDUNlist, function(gdun, callback) {
		var insightToStore;

		async.series([
		
			// Pull install base data from ECS 
			function(callback) {
				getIBdata(gdun, function(err, insight) {
					if (err) {
						console.log('Error getting install base data for GDUN=' + gdun + ': ' + err);
						callback(err); // this is the task callback saying this function is complete but with an error;	
					} else {
						insightToStore = insight;
						callback(); // this is the task callback saying this function is complete;					
					}
				});
			},
			
			// Store the resulting insight in s3
			function(callback) {
				storeInsight(gdun, insightToStore, function(err, eTag) {
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

// This function pulls the install base data for a given GDUN, calls the function to extract the insight, and then provides the insight 
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
				var dataPayload = JSON.parse(data.Body) // converts data.Body to a string replacing the array of bytes
				var payloadObject = JSON.parse(dataPayload); // converts data.Body back to an object 
				
				if (payloadObject.records < 1) {
					callback('no JSON payload in ' + key);
				} else {				
					var insight = extractInsight(payloadObject); 
					data = null; // free up memory
					dataPayload = null; // free up memory
					//console.log('insight = ' + insight);
					callback(null, insight); // this is the  callback saying this getIBdata function is complete;	
				}												
			} catch (e) {
				callback('unexpected install base JSON format in ' + key);
			}
		}
	});	
}

// This function stores the insight in s3
function storeInsight(gdun, insightToStore, callback) {
	//console.log('entering storeInsight function');
	// create JSON formatted object body to store
	var insightBody = {
	  insightToStore.toString()
	}			
		
	// put the data in the s3 bucket
	var s3params = {
			Bucket: awsBucket,
			Key: gdun + '.' + 'SNSO' + '.' + mungerNumber,
			Body: JSON.stringify(insightBody),
			ContentType: 'json'
		};	

	s3.putObject(s3params, function(err, data) {
		if (err) { 
			callback(err); // this is the  callback saying this storeInsight function is complete but with error							
		} else { 
			// successful response	
			console.log('Insight: ' + insightToStore.toString() + ' posted to s3 as: ' + gdun + '.' + 'SNSO' + '.' + mungerNumber + '\n');	
			var eTag = JSON.parse(data.ETag);
			data = null; // free up memory
			callback(null, eTag); // this is the  callback saying this storeInsight function is complete
		}						
	});
}


// This function returns the insight to the calling function. The insight is a count of the number of systems of a given
// type of 'State' found in the IB JSON of a given customer GDUN.
function extractInsight(state, installBaseData) {
	console.log('entering extractInsight function');
	
	var	mappingArray = [] // this is the mapping between a SN and an SO

	for (var i = 0; i < installBaseData.rows.length; i++) {
		mappingArray.push( {SN: installBaseData.rows[i].ITEM_SERIAL_NUMBER, SO: installBaseData.rows[i].SALES_ORDER} )
	}
	
	installBaseData = null; // free up memory
	return mappingArray;
}


