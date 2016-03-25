var url = require('url');
var http = require('http');

module.exports = function(args) {
	var URL = url.parse(args['url']);
	var actorPath = URL['hash']?URL['hash'].slice(1):'debugger';
	var requestOptions = {
		hostname: URL.hostname,
		port: URL.port,
		path: URL.path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		}
	}
	
	var connection = {
		call: function(handler, msg, callback) {
			msg['address'] = {
				target: actorPath,
				handler: handler
			};
			
			var req = http.request(requestOptions, function(res) {
				if (res.statusCode != 200) {
					return callback(new Error('Server responded with code '+res.statusCode+' ('+res.statusMessage+')'));
				}
				
				var data = '';

				res.on('data', function(newData) {
					data += newData;
				});

				res.on('end', function() {
					try {
						var jsData = JSON.parse(data);
						callback(null, jsData);
					} catch(e) {
						callback(e);
					}
				});
			}).on('error', function(e) {callback(e);});
			
			req.write(JSON.stringify(msg));
			req.end();
		},
		prompt: URL.host
	}
	
	return connection;
}
