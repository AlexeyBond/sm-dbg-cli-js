"use strict";

function getTargetView(target) {
    if (target['target'] && target['handler']) {
        var paramsInfo = [], params = target['parameters'] || {};
        var paramNames = Object.keys(params), i;

        for (i = 0; i < paramNames.length; ++i) {
            paramsInfo.push('\t' + paramNames[i] + '=' + params[paramNames[i]]);
        }

        return {
            'name': 'actor://' + target['target']['path'] + '/#' + target['handler']['path'],
            'info': paramsInfo
        }
    } else if (target['messageMapId']) {
        return {
            'name': 'map://'+target['messageMapId']['id'],
            'info': []
        }
    } else if (target['target'] == 'exchanging') {
        return {
            'name': 'EXCHANGING',
            'info': []
        }
    } else {
        paramsInfo = [];
        paramNames = Object.keys(target);

        for (i = 0; i < paramNames.length; ++i) {
            paramsInfo.push('\t'+paramNames[i]+'='+target[paramNames[i]]);
        }

        return {
            'name': 'Target with:',
            'info': paramNames
        }
    }
}

module.exports = {
    'watch': {
        'help': 'Show list of watch expressions and their current values (if available)',
        'action': function (session, stateResponse) {
            var doNotShow = (null == stateResponse['messageContent']);
            var i, value;
            if (doNotShow) {
                console.log('No message available.');
            }

            for (i = 0; i < session.watches.length; ++i) {
                console.log(''+(i+1)+')\t'+session.watches[i].source);
                if (doNotShow) {
                    continue;
                }

                try {
                    value = session.watches[i].func(stateResponse.messageContent);
                } catch (e) {
                    value = 'Error evaluating expression: ' + e.stack;
                }
                console.log('\t=',value);
            }
        }
    },
    'map': {
        'help': 'Show current state of message map.',
        'action': function (session, stateResponse) {
            var targets = stateResponse['mapTargets'];
            var cursor = stateResponse['mapIndex'];
            var i;
            if (!targets) {
                console.log('No message map present.');
                return;
            }

            console.log('Message map has', targets.length, 'target(s).');

            if (stateResponse['finished']) {
                console.log('Message map is finished.');
            }

            if (stateResponse['lastDebugException']) {
                console.log('Map is interrupted exceptionally.');
                console.log('\tUse ".show exception" to show exception.');
            }

            for (i = 0; i < targets.length; ++i) {
                var targetView = getTargetView(targets[i]);
                console.log(((i==cursor)?'->':''));
                console.log('\t'+'[]'); // TODO: Display breakpoints
                console.log('\t'+i+')',targetView.name);
            }
        }
    },
    'exception': {
        'help': 'Show the exception that caused map interruption (if any)',
        'action': function (session, stateResponse) {
            if (!stateResponse['lastDebugException']) {
                console.log('No exception.');
                return;
            }

            console.log(stateResponse['lastDebugException']);
        }
    },
    'help': {
        'help': 'Show this message',
        'action': function () {
            var i, keys = Object.keys(module.exports);

            console.log('Allowed .show arguments:');

            for (i = 0; i < keys.length; ++i) {
                console.log('\t'+keys[i]+'\t- '+module.exports[keys[i]].help);
            }
        }
    }
};
