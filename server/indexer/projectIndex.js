// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { TemplateIndexer } = require("./templateIndexer");
const { ComponentIndexer } = require("./componentIndexer");
const { TypeService, isFileTraceEnabled, traceFiles, fallbackStringMatch } = require("../typescript/typeService");
const { createDebouncedEmitter, getRegistryPath } = require("../typescript/templateRegistryEmitter");
const { loadIndexCache, hydrateFromCache } = require("../typescript/indexCache");
const { Worker, MessageChannel, receiveMessageOnPort } = require("node:worker_threads");

const SYNC_QUERY_TIMEOUT_MS = 1000;

/**
 * @typedef {import("../parsers/spacebarsParser").TemplateBlock} TemplateBlock
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 * @typedef {import("../parsers/componentParser").HelperInfo} HelperInfo
 * @typedef {import("../parsers/componentParser").ContextField} ContextField
 */

/** @param {string} p */
function isDirectorySync(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** @param {string} p */
function isFileSync(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

const IGNORE_DIRS = new Set([
  "node_modules", ".meteor", ".git", ".deploy",
  "cordova-build-override", "public", "resources",
  ".blaze-component-lsp"
]);

class ProjectIndex {
  /**
   * @param {string} rootPath - Project root directory
   */
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.typeService = new TypeService(rootPath);
    this.templateIndexer = new TemplateIndexer();
    this.componentIndexer = new ComponentIndexer(this.typeService);
    /** @type {Set<string>} */
    this._indexedFiles = new Set();
    this._registryEmitter = createDebouncedEmitter(this);
    /** @type {boolean} */
    this.ready = false;
    /** @type {boolean} */
    this.scanning = false;
    /** @type {boolean} */
    this.hydratedFromCache = false;
    /** @type {number} */
    this.generation = 0;
    /** @type {((info: { generation: number, hydrated: boolean }) => void)|null} */
    this._onScanComplete = null;
    /** @type {boolean} */
    this._bootScheduled = false;
    /** @type {Worker|null} */
    this._worker = null;
    /** @type {boolean} */
    this._workerTypesReady = false;
    /** @type {{ port: import("node:worker_threads").MessagePort, flag: Int32Array }|null} */
    this._syncChannel = null;
    this._syncQueryId = 0;
    /** @type {Map<string, boolean>} */
    this._assignableCache = new Map();
    /** @type {(() => void)|null} */
    this._onFilesUpdated = null;
  }

  /**
   * Fast boot: hydrate from index-cache.json if present, then schedule a full
   * background scan that rewrites registries when finished.
   * `useWorker` moves the TypeScript scan/enrichment into a worker thread so the
   * calling thread stays responsive; results are merged back when ready.
   * @param {{ onScanComplete?: (info: { generation: number, hydrated: boolean }) => void, useWorker?: boolean, onFilesUpdated?: () => void }} [options]
   * @returns {{ hydrated: boolean }}
   */
  boot(options = {}) {
    if (options.onScanComplete) {
      this._onScanComplete = options.onScanComplete;
    }
    if (options.onFilesUpdated) {
      this._onFilesUpdated = options.onFilesUpdated;
    }

    const cache = loadIndexCache(this.rootPath);
    if (cache) {
      hydrateFromCache(this, cache);
      this.hydratedFromCache = true;
      this.ready = true;
    } else {
      this.hydratedFromCache = false;
      this.ready = true; // empty but usable; completions grow as scan runs
    }

    if (!this._bootScheduled) {
      this._bootScheduled = true;
      this.scanning = true;
      const hydrated = this.hydratedFromCache;
      // Delay slightly so didOpen / first completions can run from cache first.
      setTimeout(() => {
        const finish = () => {
          this.scanning = false;
          this.generation += 1;
          if (this._onScanComplete) {
            this._onScanComplete({ generation: this.generation, hydrated });
          }
        };
        const runLocal = () => {
          this._runBackgroundScan()
            .catch((err) => {
              console.error("[blaze-component-lsp] Background scan failed:", err);
            })
            .finally(finish);
        };
        if (options.useWorker && this._startWorker(finish, runLocal)) return;
        runLocal();
      }, 75);
    }

    return { hydrated: this.hydratedFromCache };
  }

  /**
   * Synchronous full scan (CLI / tests).
   *
   * Parse HTML/JS first *without* creating the TypeScript LanguageService, then
   * optionally enrich once. Checker enrichment dominates runtime on large apps
   * (~minutes); tests keep it on by default, CLI uses `{ enrich: false }`.
   *
   * @param {{ enrich?: boolean }} [options]
   */
  scan(options = {}) {
    const enrich = options.enrich !== false;

    this._indexedFiles.clear();
    this.templateIndexer.templates.clear();
    this.templateIndexer.fileTemplates.clear();
    this.componentIndexer.components.clear();
    this.componentIndexer.fileComponents.clear();
    this.componentIndexer.globalHelpers.clear();
    this.componentIndexer._fileGlobalHelpers.clear();
    this.componentIndexer._mtimes.clear();

    // Phase 1: parse only (typeService.isReady === false → no per-file enrichment)
    this._scanDirectory(this.rootPath);
    this._flushRegistries();

    // Phase 2: LanguageService + enrichment (expensive)
    if (enrich) {
      try {
        this.typeService.ensureReady();
        this.componentIndexer.enrichTypesSync();
        this._flushRegistries();
      } catch (err) {
        console.error(
          `[blaze-component-lsp] Type enrichment failed for ${this.rootPath} (registries kept from parse):`,
          err
        );
      }
    }

    this.ready = true;
    this.scanning = false;
    this.generation += 1;
  }

  /**
   * Fast path for CLI:
   * - Prefer index-cache.json (JSDoc/helper types already stored)
   * - On miss: parse-only scan (skip checker enrichment — that is the slow part)
   * - Do not force TypeService.ensureReady(); assignability falls back to string
   *   matching until/unless something else warms the checker
   * @returns {"cache"|"scan"}
   */
  loadForCli() {
    const cache = loadIndexCache(this.rootPath);
    if (cache) {
      hydrateFromCache(this, cache);
      this.hydratedFromCache = true;
      this.ready = true;
      // Re-parse only files that changed; TypeService not ready → JSDoc parse only
      this.refreshStaleComponents();
      this.generation += 1;
      return "cache";
    }
    this.scan({ enrich: false });
    return "scan";
  }

  /**
   * Spawn the enrichment worker. Returns false if it could not be started.
   * @param {() => void} onDone - initial scan finished (success or failure)
   * @param {() => void} fallback - run the scan on this thread instead
   * @returns {boolean}
   */
  _startWorker(onDone, fallback) {
    try {
      const sync = new MessageChannel();
      const syncFlag = new SharedArrayBuffer(4);
      const worker = new Worker(path.join(__dirname, "enrichWorker.js"), {
        workerData: { rootPath: this.rootPath, syncPort: sync.port2, syncFlag },
        transferList: [sync.port2]
      });
      this._worker = worker;
      this._syncChannel = { port: sync.port1, flag: new Int32Array(syncFlag) };
      let finished = false;

      worker.on("message", (/** @type {any} */ msg) => {
        if (msg.type === "scanDone") {
          hydrateFromCache(this, msg.cache);
          this._workerTypesReady = true;
          this._assignableCache.clear();
          finished = true;
          onDone();
        } else if (msg.type === "scanFailed") {
          console.error("[blaze-component-lsp] Worker scan failed:", msg.message);
          this._disposeWorker();
          finished = true;
          fallback();
        } else if (msg.type === "files") {
          for (const f of msg.files) {
            this.componentIndexer.applyFileResult(f.filePath, f.components, f.globals);
          }
          this._assignableCache.clear();
          this._registryEmitter.schedule();
          if (this._onFilesUpdated) this._onFilesUpdated();
        } else if (msg.type === "error") {
          console.error("[blaze-component-lsp] Worker error:", msg.message);
        }
      });
      worker.on("error", (err) => {
        console.error("[blaze-component-lsp] Enrichment worker crashed:", err);
        this._disposeWorker();
        if (!finished) {
          finished = true;
          fallback();
        }
      });
      worker.on("exit", () => {
        if (this._worker === worker) this._disposeWorker();
      });

      this.typeService.onOverlay = (filePath, content) => {
        if (filePath.endsWith(".d.ts") && this._worker) {
          this._worker.postMessage({ type: "overlay", filePath, content });
        }
      };
      return true;
    } catch (err) {
      console.error("[blaze-component-lsp] Could not start enrichment worker:", err);
      this._disposeWorker();
      return false;
    }
  }

  /**
   * Stop the enrichment worker (if any) and return to in-thread behaviour.
   */
  _disposeWorker() {
    const worker = this._worker;
    this._worker = null;
    this._workerTypesReady = false;
    this.typeService.onOverlay = null;
    if (this._syncChannel) {
      this._syncChannel.port.close();
      this._syncChannel = null;
    }
    if (worker) worker.terminate().catch(() => {});
  }

  /**
   * Release background resources (worker thread, timers).
   */
  dispose() {
    this._registryEmitter.cancel();
    this._disposeWorker();
  }

  /**
   * Ask the worker whether actual is assignable to expected, synchronously.
   * @param {string} actual
   * @param {string} expected
   * @returns {boolean|undefined} undefined when the worker is busy/unavailable
   */
  _workerAssignable(actual, expected) {
    const ch = this._syncChannel;
    if (!ch) return undefined;
    const id = ++this._syncQueryId;
    Atomics.store(ch.flag, 0, 0);
    ch.port.postMessage({ id, actual, expected });
    if (Atomics.wait(ch.flag, 0, 0, SYNC_QUERY_TIMEOUT_MS) === "timed-out") return undefined;
    for (let m = receiveMessageOnPort(ch.port); m; m = receiveMessageOnPort(ch.port)) {
      if (m.message.id === id) return m.message.result;
    }
    return undefined;
  }

  /**
   * @returns {Promise<void>}
   */
  _yield() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Full re-index in background after boot().
   * Phase 1: parse HTML/JS without TypeService (keeps event loop responsive).
   * Phase 2: create LanguageService and enrich types in batches.
   * Hydrated data stays live until the phase-1 swap.
   * @returns {Promise<void>}
   */
  async _runBackgroundScan() {
    const nextTemplates = new TemplateIndexer();
    // typeService not ready yet → parse only, no checker
    const nextComponents = new ComponentIndexer(this.typeService);
    /** @type {Set<string>} */
    const nextIndexed = new Set();

    await this._scanDirectoryIntoChunked(
      this.rootPath,
      nextTemplates,
      nextComponents,
      nextIndexed
    );

    this.templateIndexer = nextTemplates;
    this.componentIndexer = nextComponents;
    this._indexedFiles = nextIndexed;

    // Write registries from parse-only data so .blaze-component-lsp/ exists even if
    // TypeService enrichment crashes (seen on larger apps via TS instantiateType).
    this._flushRegistries();

    try {
      this.typeService.ensureReady();
      await this.componentIndexer.enrichTypesChunked(() => this._yield(), 8);
      this._flushRegistries();
    } catch (err) {
      console.error(
        `[blaze-component-lsp] Type enrichment failed for ${this.rootPath} (registries kept from parse):`,
        err
      );
    }
  }

  /**
   * Emit templates.d.ts / helpers.d.ts / index-cache.json for this meteor root.
   */
  _flushRegistries() {
    const result = this._registryEmitter.flush();
    this._maybeWarnMissingRegistryPath(result.templates.path);
  }

  /**
   * Log once if tsconfig does not map blaze-component-lsp (best-effort).
   * @param {string} registryPath
   */
  _maybeWarnMissingRegistryPath(registryPath) {
    if (this._warnedMissingPath) return;
    const tsconfigPath = path.join(this.rootPath, "tsconfig.json");
    try {
      const raw = fs.readFileSync(tsconfigPath, "utf-8");
      if (!raw.includes("blaze-component-lsp")) {
        this._warnedMissingPath = true;
        console.error(
          `[blaze-component-lsp] Tip: map "blaze-component-lsp" → the package types stub ` +
          `(node_modules/blaze-component-lsp/types/index.d.ts) and include ` +
          `".blaze-component-lsp/**/*.d.ts" so TemplateContextMap augmentations merge in this program.`
        );
      }
    } catch {
      // no tsconfig
    }
  }

  /**
   * Re-index a single file (on change/save).
   * @param {string} filePath - Absolute path
   * @param {string} [source] - File content (read from disk if not provided)
   */
  updateFile(filePath, source) {
    if (filePath.endsWith(".html")) {
      this.templateIndexer.indexFile(filePath, source);
      this._indexedFiles.add(filePath);
      this._registryEmitter.schedule();
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
      if (this._worker) {
        // Parse-only here (instant); the worker sends back the checker-enriched result.
        this.componentIndexer.indexFile(filePath, source);
        this._worker.postMessage({ type: "updateFile", filePath, source });
        this._indexedFiles.add(filePath);
        this._registryEmitter.schedule();
        return;
      }
      // Ensure checker enrichment for live edits
      if (this.typeService && !this.typeService.isReady) {
        this.typeService.ensureReady();
      }
      this.componentIndexer.indexFile(filePath, source);
      this._indexedFiles.add(filePath);
      this._registryEmitter.schedule();
    }
  }

  /**
   * Remove a file from the index.
   * @param {string} filePath
   */
  removeFile(filePath) {
    if (filePath.endsWith(".html")) {
      this.templateIndexer.removeFile(filePath);
      this._registryEmitter.schedule();
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
      this.componentIndexer.removeFile(filePath);
      this.typeService.removeFile(filePath);
      if (this._worker) this._worker.postMessage({ type: "removeFile", filePath });
      this._registryEmitter.schedule();
    }
    this._indexedFiles.delete(filePath);
  }

  /**
   * Flush template/helpers registries + index cache immediately.
   * @returns {ReturnType<typeof createDebouncedEmitter> extends { flush: () => infer R } ? R : never}
   */
  emitTemplateRegistry() {
    return this._registryEmitter.flush();
  }

  /**
   * Absolute path to the generated templates.d.ts for this project.
   * @returns {string}
   */
  getTemplateRegistryPath() {
    return getRegistryPath(this.rootPath);
  }

  /**
   * Check whether actualType is assignable to expectedType via the TS checker.
   * @param {string} actualType
   * @param {string} expectedType
   * @returns {boolean}
   */
  isTypeAssignable(actualType, expectedType) {
    if (this._worker) {
      if (!this._workerTypesReady) return fallbackStringMatch(actualType, expectedType);
      const key = `${actualType}\0${expectedType}`;
      let result = this._assignableCache.get(key);
      if (result === undefined) {
        result = this._workerAssignable(actualType, expectedType);
        if (result === undefined) return fallbackStringMatch(actualType, expectedType);
        this._assignableCache.set(key, result);
      }
      return result;
    }
    return this.typeService.isAssignableByString(actualType, expectedType);
  }

  /**
   * Re-index any JS files that have changed on disk since last indexed.
   * @returns {boolean} true if anything was refreshed
   */
  refreshStaleComponents() {
    if (this._worker) {
      // Worker re-indexes stale files and reports back via onFilesUpdated.
      if (this._workerTypesReady) this._worker.postMessage({ type: "refresh" });
      return false;
    }
    if (this.typeService && !this.typeService.isReady) {
      // Nothing checker-backed yet; skip until background scan finishes
      return false;
    }
    const changed = this.componentIndexer.refreshStaleFiles();
    if (changed) this._registryEmitter.schedule();
    return changed;
  }

  /**
   * Get all available identifiers for a template (helpers + context data fields).
   * @param {string} templateName
   * @returns {{ helpers: HelperInfo[], contextFields: ContextField[] }}
   */
  getAvailableIdentifiers(templateName) {
    const component = this.componentIndexer.getComponent(templateName);
    const componentHelpers = component ? component.helpers : [];
    const contextFields = component ? component.contextDataFields : [];
    const globalHelpers = this.getGlobalHelpers();
    return {
      helpers: [...componentHelpers, ...globalHelpers],
      contextFields
    };
  }

  /**
   * Get all global helpers as HelperInfo-compatible objects.
   * @returns {import("../parsers/componentParser").HelperInfo[]}
   */
  getGlobalHelpers() {
    return Array.from(this.componentIndexer.globalHelpers.values()).map(g => ({
      name: g.name,
      methodName: g.name,
      range: g.range,
      returnType: g.returnType,
      documentation: g.documentation ? `(global) ${g.documentation}` : "(global helper)",
      params: g.params
    }));
  }

  /**
   * Get a global helper by name.
   * @param {string} name
   * @returns {import("../parsers/componentParser").GlobalHelperInfo|undefined}
   */
  getGlobalHelper(name) {
    return this.componentIndexer.globalHelpers.get(name);
  }

  /**
   * Get the component for a template.
   * @param {string} templateName
   * @returns {ComponentInfo|undefined}
   */
  getComponentForTemplate(templateName) {
    return this.componentIndexer.getComponent(templateName);
  }

  /**
   * Get the template block by name.
   * @param {string} templateName
   * @returns {TemplateBlock|undefined}
   */
  getTemplate(templateName) {
    return this.templateIndexer.getTemplate(templateName);
  }

  /**
   * Get all known template names.
   * @returns {string[]}
   */
  getAllTemplateNames() {
    return this.templateIndexer.getAllTemplateNames();
  }

  /**
   * Get all block template names (templates that use Template.contentBlock/elseBlock).
   * @returns {string[]}
   */
  getBlockTemplateNames() {
    return this.templateIndexer.getBlockTemplateNames();
  }

  /**
   * Get templates defined in a specific file.
   * @param {string} filePath
   * @returns {TemplateBlock[]}
   */
  getTemplatesInFile(filePath) {
    return this.templateIndexer.getTemplatesInFile(filePath);
  }

  /**
   * Find all references to a helper across all templates.
   * @param {string} helperName
   * @returns {{ templateName: string, filePath: string, loc: import("../parsers/spacebarsParser").SourceRange }[]}
   */
  findHelperReferences(helperName) {
    const { flattenExpressions } = require("../parsers/spacebarsParser");
    /** @type {{ templateName: string, filePath: string, loc: import("../parsers/spacebarsParser").SourceRange }[]} */
    const refs = [];

    for (const [name, template] of this.templateIndexer.templates) {
      const flat = flattenExpressions(template.expressions);
      for (const expr of flat) {
        if (expr.path === helperName && (expr.type === "MustacheExpression" || expr.type === "RawExpression")) {
          refs.push({
            templateName: name,
            filePath: template.filePath || "",
            loc: expr.loc
          });
        }
      }
    }

    return refs;
  }

  /**
   * Find all references to a template (partial inclusions).
   * @param {string} templateName
   * @returns {{ fromTemplate: string, filePath: string, loc: import("../parsers/spacebarsParser").SourceRange }[]}
   */
  findTemplateReferences(templateName) {
    const { flattenExpressions } = require("../parsers/spacebarsParser");
    /** @type {{ fromTemplate: string, filePath: string, loc: import("../parsers/spacebarsParser").SourceRange }[]} */
    const refs = [];

    for (const [name, template] of this.templateIndexer.templates) {
      const flat = flattenExpressions(template.expressions);
      for (const expr of flat) {
        if (expr.type === "PartialExpression" && expr.path === templateName) {
          refs.push({
            fromTemplate: name,
            filePath: template.filePath || "",
            loc: expr.loc
          });
        }
      }
    }

    return refs;
  }

  /**
   * Recursively scan a directory for HTML and JS files into this index.
   * @param {string} dirPath
   */
  _scanDirectory(dirPath) {
    this._scanDirectoryInto(dirPath, this.templateIndexer, this.componentIndexer, this._indexedFiles);
  }

  /**
   * Recursively scan into explicit indexers (used by sync scan()).
   * @param {string} dirPath
   * @param {TemplateIndexer} templates
   * @param {ComponentIndexer} components
   * @param {Set<string>} indexedFiles
   */
  _scanDirectoryInto(dirPath, templates, components, indexedFiles) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectorySync(fullPath));
      const isFile = entry.isFile() || (entry.isSymbolicLink() && isFileSync(fullPath));

      if (isDir) {
        this._scanDirectoryInto(fullPath, templates, components, indexedFiles);
      } else if (isFile) {
        if (entry.name.endsWith(".html")) {
          if (isFileTraceEnabled()) {
            traceFiles(`index html ${path.relative(this.rootPath, fullPath)}`);
          }
          templates.indexFile(fullPath);
          indexedFiles.add(fullPath);
        } else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) {
          if (isFileTraceEnabled()) {
            traceFiles(`index js ${path.relative(this.rootPath, fullPath)}`);
          }
          components.indexFile(fullPath);
          indexedFiles.add(fullPath);
        }
      }
    }
  }

  /**
   * Chunked async scan — yields every few files so LSP requests can run.
   * @param {string} dirPath
   * @param {TemplateIndexer} templates
   * @param {ComponentIndexer} components
   * @param {Set<string>} indexedFiles
   * @returns {Promise<void>}
   */
  async _scanDirectoryIntoChunked(dirPath, templates, components, indexedFiles) {
    /** @type {string[]} */
    const files = [];
    this._collectSourceFiles(dirPath, files);

    let n = 0;
    for (const fullPath of files) {
      if (fullPath.endsWith(".html")) {
        templates.indexFile(fullPath);
      } else {
        components.indexFile(fullPath);
      }
      indexedFiles.add(fullPath);
      n++;
      if (n % 20 === 0) {
        await this._yield();
      }
    }
  }

  /**
   * Collect .html/.js/.jsx paths under dirPath.
   * @param {string} dirPath
   * @param {string[]} out
   */
  _collectSourceFiles(dirPath, out) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectorySync(fullPath));
      const isFile = entry.isFile() || (entry.isSymbolicLink() && isFileSync(fullPath));

      if (isDir) {
        this._collectSourceFiles(fullPath, out);
      } else if (isFile) {
        if (
          entry.name.endsWith(".html") ||
          entry.name.endsWith(".js") ||
          entry.name.endsWith(".jsx")
        ) {
          out.push(fullPath);
        }
      }
    }
  }
}

module.exports = { ProjectIndex };
