'use strict';

// Minimal iApps LX config processor. The IAPP-tagged manifest needs a block
// processor for a clean install; rultracer itself does not depend on block
// state, so this just acknowledges BOUND/UNBOUND transitions and lets the
// real workers do their thing (data-dir init etc. happens in onStart). ES5.

var logger = require('./logger');

var WORKER_URI_PATH = 'shared/iapp/processors/rultracer';
var VERSION = '0.4.1';

function ConfigProcessor() {
    this.WORKER_URI_PATH = WORKER_URI_PATH;
    this.isPublic = true;
    this.isPassThrough = false;
}

ConfigProcessor.prototype.onStart = function (success) { success(); };

function setState(restOperation, state, outputProperties) {
    var body = restOperation.getBody() || {};
    body.state = state;
    if (outputProperties) { body.outputProperties = outputProperties; }
    restOperation.setBody(body);
}

ConfigProcessor.prototype.onPost = function (restOperation) {
    logger.info('configProcessor.onPost: BINDING -> BOUND');
    setState(restOperation, 'BOUND', [{ id: 'installedVersion', value: VERSION }]);
    this.completeRestOperation(restOperation);
};

ConfigProcessor.prototype.onPut = function (restOperation) {
    logger.info('configProcessor.onPut: re-BOUND');
    setState(restOperation, 'BOUND', [{ id: 'installedVersion', value: VERSION }]);
    this.completeRestOperation(restOperation);
};

ConfigProcessor.prototype.onDelete = function (restOperation) {
    logger.info('configProcessor.onDelete: UNBINDING -> UNBOUND (session data retained)');
    setState(restOperation, 'UNBOUND');
    this.completeRestOperation(restOperation);
};

module.exports = ConfigProcessor;
