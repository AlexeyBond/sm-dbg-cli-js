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
var REMOTE_UNCONNECTED_SESSION_IDS = [];
var CURRENT_SESSION_ID = null;
var REPL_SERVER = null;

var BINARY_ANSWERS = {
	'true': true, 'false': false,
	'yes': true, 'no': false,
	'on': true, 'off': false
};

function newSessionObject(globalId) {
	return {id: globalId, watches:[], bpCounter: 1, trCounter: 1};
}

function pushSession(sessionObject) {
	var localId = SESSIONS.length;
	SESSIONS.push(sessionObject);
	SESSION_LOCAL_IDS[sessionObject.id] = localId;
	return localId;
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
			var localId = pushSession(newSessionObject(sid));
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
	
	context['breakAt'] = function breakAt(position, options, name) {
		name = name || ('string' == typeof options && options) || ('bp'+(currentSession().bpCounter++));
		options = ('object' == typeof options && options) || {};
		callSessionCommand('newBreakpoint', {
			'breakAfter': options.hasOwnProperty('after')?options['after']:false,
			'breakBefore': options.hasOwnProperty('before')?options['before']:true,
			'active': options.hasOwnProperty('active')?options['active']:true,
			'breakpointMode': 'point',
			'targetId': (position-1),
			'breakpointId': name
		}, function(err, res) {
			if (err) {
				console.error(err);
			} else {
				console.log('Breakpoint', res['breakpointId'], 'created.')
			}
			
			resumePrompt();
		});
	};
	
	context['setTrace'] = function setTrace(name) {
		name = name || ('tr'+(currentSession().trCounter++));
		callSessionCommand('newBreakpoint', {
			'breakAfter': false,
			'breakBefore': true,
			'active': true,
			'breakpointMode': 'trace',
			'breakpointId': name
		}, function(err, res) {
			if (err) {
				console.error(err);
			} else {
				console.log('Trace', res['breakpointId'], 'created.')
			}
			
			resumePrompt();
		});
	};
	
	context['doBreak'] = function doBreak(name, reallyDo) {
		reallyDo = (reallyDo == undefined)?true:reallyDo;
		callSessionCommand('modifyBreakpoint', {
			'breakpointId': name,
			'active': reallyDo
		}, function(err, res) {
			if (err) {
				console.error(err);
			}
			
			resumePrompt();
		});
	};
	
	context['addTarget'] = function addTarget(id, target) {
		callSessionCommand('addMapTarget', {
			'targetId': id,
			'messageTarget': target
		}, function(err, res) {
			if (err) {
				console.error(err);
			}
			
			resumePrompt();
		});
	}
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
	
	REPL_SERVER.defineCommand('goto', {
		help: 'Move to a target in message map',
		action: function(arg) {
			var targetId;
			
			try {
				targetId = parseInt(arg);
			} catch (e) {
				console.error('Target id must be an integer.');
				resumePrompt();
				return;
			}
			
			callSessionCommand('goTo', {
				'targetId': targetId
			}, function(err) {
				if (err) {
					console.error(err);
				}
				
				resumePrompt();
			});
		}
	});
	
	REPL_SERVER.defineCommand('addtarget', {
		help: 'Add a target after current poition in message map',
		action: function(arg) {
			try {
				var target = eval('('+arg+')');
			} catch (e) {
				console.error(e.stack);
				resumePrompt();
				return;
			}
			
			callSessionCommand('addMapTarget', {
				'messageTarget': target
			}, function(err) {
				if (err) {
					console.error(err);
				}
				
				resumePrompt();
			});
		}
	});
	
	REPL_SERVER.defineCommand('rmtarget', {
		help: 'Remove a target after current poition in message map',
		action: function() {
			callSessionCommand('removeMapTarget', {}, function(err) {
				if (err) {
					console.error(err);
				}
				
				resumePrompt();
			});
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
	
	REPL_SERVER.defineCommand('dump', {
		help: 'Create a dump of message.',
		action: function() {
			callSessionCommand('makeDump', {}, function(err) {
				if (err) {
					console.error(err);
				}
				
				resumePrompt();
			})
		}
	});
	
	REPL_SERVER.defineCommand('listSessions', {
		help: 'Get list of debugger sessions exist on server.',
		action: function() {
			connection.call('listSessions', {}, function(err, res) {
				if (err) {
					console.error(err);
				} else {
					var sessions = res['sessionsList'], i;
					var remoteIds = [];
					console.log('There is',sessions.length,'session(s).');
					for (i = 0; i < sessions.length; ++i) {
						var localId = SESSION_LOCAL_IDS[sessions[i]];
						if (localId != undefined) {
							console.log('\t', sessions[i], ' (connected, '+localId+')');
						} else {
							console.log(''+remoteIds.length+')\t', sessions[i]);
							remoteIds.push(sessions[i]);
						}
					}
					REMOTE_UNCONNECTED_SESSION_IDS = remoteIds;
				}
				
				resumePrompt();
			});
		}
	});
	
	REPL_SERVER.defineCommand('connect', {
		help: 'Connect to remote session (use ".listSessions" to get list of unconnected sessions).',
		action: function(arg) {
			var localRemoteId;
			
			try {
				localRemoteId = parseInt(arg);
			} catch (e) {
				console.error('Session id should be an integer (the index printed by ".listSessions").');
				return resumePrompt();
			}
			
			if (REMOTE_UNCONNECTED_SESSION_IDS.length <= localRemoteId || localRemoteId < 0 || REMOTE_UNCONNECTED_SESSION_IDS[localRemoteId] == undefined) {
				console.error('There is no session with given id.');
				console.log(REMOTE_UNCONNECTED_SESSION_IDS);
				return resumePrompt();
			}
			
			var globalId = REMOTE_UNCONNECTED_SESSION_IDS[localRemoteId];
			var localId = pushSession(newSessionObject(globalId));
			REMOTE_UNCONNECTED_SESSION_IDS[localRemoteId] = null;
			
			goToSession(localId);
			console.log('Connected to remote session', '#'+globalId, 'as local session', localId);
			resumePrompt();
		}
	})

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
