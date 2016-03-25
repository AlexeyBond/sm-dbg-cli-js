#!/usr/bin/env nodejs

var repl = require('repl');
var cliArgs = require('optimist').argv;
var connection = require('./lib/connection')(cliArgs);

function checkResponseErrors(res, callback) {
	if (res['exception']) {
		callback(new Error('Actor threw exception.'));
		return false;
	}
	
	return true;
}

var SESSION_LOCAL_IDS = {};
var SESSIONS = [];
var CURRENT_SESSION_ID = null;
var REPL_SERVER = null;

function newSessionObject(globalId) {
	return {id: globalId};
}

function openSesion(callback) {
	connection.call('openSession', {}, function(err, res) {
		if (err) {
			callback(err);
		}
		
		if (checkResponseErrors(res, callback)) {
			var sid = res['debugSessionId'];
			var localId = SESSIONS.length;
			SESSIONS.push(newSessionObject(sid));
			console.log('New session: '+sid+' local id = '+localId)
			callback(null, localId);
		}
	});
}

function closeSession(localId, callback) {
	if (localId < 0 || localId >= SESSIONS.length) {
		console.error('Session id is out of range.');
		setImmediate(callback);
		return;
	}

	var session = SESSIONS[localId];

	if (!session) {
		setImmediate(callback);
		return;
	}
	
	connection.call('closeSession', {debugSessionId: session.id}, function(err, res) {
		SESSIONS[localId] = null;
		return callback(err);
	});
}

function formPrompt() {
	return 'SMDBG@'+connection.prompt+'['+CURRENT_SESSION_ID+']('+SESSIONS[CURRENT_SESSION_ID].id.slice(0,8)+')>';
}

function resumePrompt() {
	REPL_SERVER.displayPrompt();
}

function goToSession(id) {
	if (id < 0 || id >= SESSIONS.length) {
		console.error('Session id = '+id+' out of range.');
	} else if (!(SESSIONS[id])) {
		console.error('The session is closed.');
	} else {
		CURRENT_SESSION_ID = id;
		// REPL_SERVER.setPrompt(formPrompt());
		REPL_SERVER.prompt = formPrompt();
	}
	resumePrompt();
}

function startRepl() {
	REPL_SERVER = repl.start({
		prompt: formPrompt(),
		useColors: true,
		replMode: repl.REPL_MODE_STRICT
	});
	
	REPL_SERVER.on('reset', function(context) {
		
	});
	
	REPL_SERVER.defineCommand('session', {
		help: 'Switch to another session or create new one',
		action: function(arg) {
			if (('new' === arg) || !arg) {
				openSesion(function(err, id) {
					if (err) {
						console.error(err);
					} else {
						goToSession(id);
					}
					resumePrompt();
				});
			} else {
				var id;
				
				try {
					id = parseInt(arg);
				} catch (e) {
					console.error('Session id should be an integer.')
				}
				
				goToSession(id);
			}
		}
	});
	
	REPL_SERVER.defineCommand('close', {
		help: 'Close a debug session',
		action: function(arg) {
			var id;
			
			try {
				id = parseInt(arg);
			} catch(e) {
				console.error('Session id should be an integer.');
				resumePrompt();
				return;
			}
			
			if (id == CURRENT_SESSION_ID) {
				console.error('Can not close current session.');
				resumePrompt();
				return;
			}
			
			closeSession(id, function(err) {
				if (err) {
					console.error(err);
				}
				
				resumePrompt();
			});
		}
	});
}

openSesion(function(err,id) {
	if (err) {
		return console.error(err);
	}
	
	CURRENT_SESSION_ID = id;
	
	startRepl();
});
