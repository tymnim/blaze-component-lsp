// @ts-check
// Runs the TypeScript-backed scan/enrichment off the LSP main thread so
// requests (definition, hover, completion) are never blocked by the checker.
const { parentPort, workerData } = require("node:worker_threads");
const { ProjectIndex } = require("./projectIndex");
const { serializeIndexCache } = require("../typescript/indexCache");

if (!parentPort) throw new Error("enrichWorker must run in a worker thread");
const port = parentPort;

const index = new ProjectIndex(workerData.rootPath, { boundaryDirs: workerData.boundaryDirs });

/** @param {string} filePath */
function snapshotFile(filePath) {
  return {
    filePath,
    components: index.componentIndexer.fileComponents.get(filePath) || [],
    globals: index.componentIndexer._fileGlobalHelpers.get(filePath) || []
  };
}

/** @param {string[]} filePaths */
function postFiles(filePaths) {
  if (filePaths.length) port.postMessage({ type: "files", files: filePaths.map(snapshotFile) });
}

// Serve synchronous assignability queries from the main thread (Atomics handshake).
const { syncPort, syncFlag } = workerData;
const flag = new Int32Array(syncFlag);
syncPort.on("message", (/** @type {{ id: number, actual: string, expected: string }} */ msg) => {
  let result = true;
  try {
    result = index.typeService.isAssignableByString(msg.actual, msg.expected);
  } catch {}
  syncPort.postMessage({ id: msg.id, result });
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});

port.on("message", (/** @type {any} */ msg) => {
  try {
    switch (msg.type) {
      case "overlay":
        index.typeService.updateFile(msg.filePath, msg.content);
        break;
      case "updateFile":
        index.updateFile(msg.filePath, msg.source);
        postFiles([msg.filePath]);
        break;
      case "removeFile":
        index.removeFile(msg.filePath);
        break;
      case "refresh": {
        /** @type {string[]} */
        const changed = [];
        index.componentIndexer.refreshStaleFiles((fp) => changed.push(fp));
        postFiles(changed);
        break;
      }
    }
  } catch (err) {
    port.postMessage({ type: "error", message: String(err && /** @type {Error} */ (err).stack || err) });
  }
});

index._runBackgroundScan()
  .then(() => {
    // Main thread owns registry emission once the initial scan is done.
    index._registryEmitter = { schedule() {}, flush() { return /** @type {any} */ ({}); }, cancel() {} };
    port.postMessage({ type: "scanDone", cache: serializeIndexCache(index) });
  })
  .catch((err) => {
    port.postMessage({ type: "scanFailed", message: String(err && err.stack || err) });
  });
