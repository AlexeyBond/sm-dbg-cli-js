#!/usr/bin/env nodejs

var path = require('path');
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

var SHOW_ASPECTS = require('./lib/shows');

var SESSION_LOCAL_IDS = {};
var SESSIONS = [];
var CURRENT_SESSION_ID = null;
var REPL_SERVER = null;

var BINARY_ANSWERS = {
	'true': true, 'false': false,
	'yes': true, 'no': false,
	'on': true, 'off': false
};

function newSessionObject(globalId) {
	return {id: globalId, watches:[]};
}

function currentSession() {
	return SESSIONS[CURRENT_SESSION_ID];
}

function openSesion(callback) {
	connection.call('openSession', {}, function(err, res) {
		if (err) {
			return callback(err);
		}
		
		if (checkResponseErrors(res, callback)) {
			var sid = res['debugSessionId'];
			var localId = SESSIONS.length;
			SESSIONS.push(newSessionObject(sid));
			SESSION_LOCAL_IDS[sid] = localId;
			console.log('New session: '+sid+' local id = '+localId);
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

function stringifyJavaException(e) {
	while (e.cause) {
		e = e.cause;
	}

	if (!e.detailMessage) {
		console.error(e);
	}

	return 'Server error: '+(e.detailMessage || e.message || 'unknown error');
}

function callSessionCommand(command, args, callback) {
	args['debugSessionId'] = SESSIONS[CURRENT_SESSION_ID].id;

	connection.call(command, args, function(err,res) {
		if (err) {
			callback(err);
		} else if (res['exception']) {
			callback(new Error(stringifyJavaException(res['exception'])));
		} else {
			callback(null, res);
		}
	});
}

function formPrompt() {
	return 'SMDBG@'+connection.prompt+'['+CURRENT_SESSION_ID+']('+SESSIONS[CURRENT_SESSION_ID].id.slice(0,8)+')>';
}

function resumePrompt() {
	REPL_SERVER.displayPrompt(true);
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

function setupREPLContext(context) {
	context['message'] = function message(msg_, address_) {
		if (msg_ && address_) {
			callSessionCommand('setMessageContent', {
				messageContent: msg_,
				messageTarget: address_
			}, function (err, res) {
				if (err) {
					console.error(err);
				}

				resumePrompt();
			});
		} else {
			return {
				to: function (address) {
					return message(msg_, address);
				},
				of: function (msg) {
					return message(msg, address_)
				}
			}
		}
	};
}

function startRepl() {
	REPL_SERVER = repl.start({
		prompt: formPrompt(),
		useColors: true,
		replMode: repl.REPL_MODE_STRICT,
		ignoreUndefined: true
	});

	setupREPLContext(REPL_SERVER.context);
	REPL_SERVER.on('reset', setupREPLContext);
	
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
	
	REPL_SERVER.defineCommand('trace', {
		help: 'Enable or disable trace mode',
		action: function(arg) {
			if (!BINARY_ANSWERS.hasOwnProperty(arg)) {
				console.error('Wrong argument value expected one of: '+Object.keys(BINARY_ANSWERS).join(', '));
				resumePrompt();
				return;
			}
			
			callSessionCommand('setTrace', {trace:BINARY_ANSWERS[arg]}, function(err) {
				if (err) {
					console.error(err);
				}

				resumePrompt();
			});
		}
	});

	REPL_SERVER.defineCommand('go', {
		help: 'Start/continue/step message map execution.',
		action: function() {
			callSessionCommand('go', {}, function(err) {
				if (err) {
					console.error(err);
				}

				resumePrompt();
			});
		}
	});

	REPL_SERVER.defineCommand('watch', {
		help: 'Add a "watch" expression.',
		action: function (expr) {
			try {
				currentSession().watches.push({
					source: expr,
					func: new Function('$', '{return ' + expr + ';}')
				});
			} catch (e) {
				console.error('Error creating watch expression:');
				console.error(e);
			}

			resumePrompt();
		}
	});

	REPL_SERVER.defineCommand('show', {
		help: 'Query and show some aspects of the debug session.',
		action: function (arg) {
			if (!SHOW_ASPECTS.hasOwnProperty(arg)) {
				console.log('Wrong .show argument. Use ".show help" to see available.');
				resumePrompt();
				return;
			}

			connection.call('getState', {debugSessionId: SESSIONS[CURRENT_SESSION_ID].id}, function(err, res) {
				if (err) {
					console.error(err);
				} else {
					SHOW_ASPECTS[arg].action(currentSession(), res);
				}

				resumePrompt();
			});
		}
	});
	
	REPL_SERVER.defineCommand('stat', {
		help: 'Query and print session state.',
		action: function() {
			connection.call('getState', {debugSessionId: SESSIONS[CURRENT_SESSION_ID].id}, function(err, res) {
				if (err) {
					console.error(err);
				} else {
					console.log(res);
				}

				resumePrompt();
			});
		}
	});

	try {
		require('repl.history')(REPL_SERVER, path.join(process.env['HOME'], '.sm-dbg-cli-js-history'));
	} catch (e) {
		console.warn('History initialization failed: ', e);
	}
}

openSesion(function(err,id) {
	if (err) {
		return console.error(err);
	}
	
	CURRENT_SESSION_ID = id;
	
	startRepl();
});
