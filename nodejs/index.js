'use strict';

/**
 * index.js
 *
 * restnoded scans every .js file under the nodejs/ tree and instantiates the
 * ones that export a constructor with a WORKER_URI_PATH as RestWorkers. It
 * does NOT require() this file to find them. Exporting nothing here keeps
 * restnoded quiet (no "WorkerDef is not a constructor" warning).
 *
 * Workers registered by this package:
 *   - lib/configProcessor.js  -> /mgmt/shared/iapp/processors/rultracer
 *   - lib/InventoryWorker.js  -> /mgmt/shared/rultracer/inventory
 *   - lib/ProfilerWorker.js   -> /mgmt/shared/rultracer/profiler
 *   - lib/SessionWorker.js    -> /mgmt/shared/rultracer/sessions
 *   - lib/TrafficWorker.js    -> /mgmt/shared/rultracer/traffic
 *   - lib/UiWorker.js         -> /mgmt/shared/rultracer/ui
 *
 * Helpers (NOT workers; required directly by the above):
 *   capture, engine, iremote, logchain, logger, profiler, restutil,
 *   settings, store, tmsh, util, validate.
 */
