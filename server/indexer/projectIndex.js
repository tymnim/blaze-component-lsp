// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { TemplateIndexer } = require("./templateIndexer");
const { ComponentIndexer } = require("./componentIndexer");
const { TypeService, isFileTraceEnabled, traceFiles } = require("../typescript/typeService");
const { createDebouncedEmitter, getRegistryPath } = require("../typescript/templateRegistryEmitter");
const { loadIndexCache, hydrateFromCache } = require("../typescript/indexCache");

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
  }

  /**
   * Fast boot: hydrate from index-cache.json if present, then schedule a full
   * background scan that rewrites registries when finished.
   * @param {{ onScanComplete?: (info: { generation: number, hydrated: boolean }) => void }} [options]
   * @returns {{ hydrated: boolean }}
   */
  boot(options = {}) {
    if (options.onScanComplete) {
      this._onScanComplete = options.onScanComplete;
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
        this._runBackgroundScan()
          .catch((err) => {
            console.error("[blaze-component-lsp] Background scan failed:", err);
          })
          .finally(() => {
            this.scanning = false;
            this.generation += 1;
            if (this._onScanComplete) {
              this._onScanComplete({ generation: this.generation, hydrated });
            }
          });
      }, 75);
    }

    return { hydrated: this.hydratedFromCache };
  }

  /**
   * Synchronous full scan (CLI / tests). Ensures TypeService is ready first.
   */
  scan() {
    this.typeService.ensureReady();
    this._indexedFiles.clear();
    this.templateIndexer.templates.clear();
    this.templateIndexer.fileTemplates.clear();
    this.componentIndexer.components.clear();
    this.componentIndexer.fileComponents.clear();
    this.componentIndexer.globalHelpers.clear();
    this.componentIndexer._fileGlobalHelpers.clear();
    this.componentIndexer._mtimes.clear();

    this._scanDirectory(this.rootPath);
    const result = this._registryEmitter.flush();
    this._maybeWarnMissingRegistryPath(result.templates.path);
    this.ready = true;
    this.scanning = false;
    this.generation += 1;
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

    // Expensive: LanguageService over the project, then enrich in batches
    this.typeService.ensureReady();
    await this.componentIndexer.enrichTypesChunked(() => this._yield(), 8);

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
          `[blaze-component-lsp] Tip: map "blaze-component-lsp" → "${path.relative(this.rootPath, registryPath)}" in tsconfig paths so import(\"blaze-component-lsp\").Template resolves in the editor.`
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
    return this.typeService.isAssignableByString(actualType, expectedType);
  }

  /**
   * Re-index any JS files that have changed on disk since last indexed.
   * @returns {boolean} true if anything was refreshed
   */
  refreshStaleComponents() {
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
