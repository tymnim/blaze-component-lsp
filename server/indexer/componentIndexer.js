// @ts-check
const fs = require("node:fs");
const { parseComponent, findGlobalHelpers } = require("../parsers/componentParser");
const {
  resolveComponentTypes,
  resolveGlobalHelperTypes
} = require("../typescript/resolveComponentTypes");

/**
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 * @typedef {import("../parsers/componentParser").GlobalHelperInfo} GlobalHelperInfo
 * @typedef {import("../typescript/typeService").TypeService} TypeService
 */

class ComponentIndexer {
  /**
   * @param {TypeService|null} [typeService]
   */
  constructor(typeService = null) {
    /** @type {TypeService|null} */
    this.typeService = typeService;
    /** @type {Map<string, ComponentInfo>} templateName → ComponentInfo */
    this.components = new Map();
    /** @type {Map<string, ComponentInfo[]>} filePath → ComponentInfo[] */
    this.fileComponents = new Map();
    /** @type {Map<string, number>} filePath → mtime (ms) when last indexed */
    this._mtimes = new Map();
    /** @type {Map<string, GlobalHelperInfo>} helperName → GlobalHelperInfo */
    this.globalHelpers = new Map();
    /** @type {Map<string, GlobalHelperInfo[]>} filePath → GlobalHelperInfo[] */
    this._fileGlobalHelpers = new Map();
  }

  /**
   * Index a single JS file.
   * @param {string} filePath - Absolute path
   * @param {string} [source] - File contents (read from disk if not provided)
   */
  indexFile(filePath, source) {
    if (source === undefined) {
      try {
        source = fs.readFileSync(filePath, "utf-8");
      } catch {
        return;
      }
    }

    try {
      const stat = fs.statSync(filePath);
      this._mtimes.set(filePath, stat.mtimeMs);
    } catch {
      this._mtimes.set(filePath, Date.now());
    }

    if (this.typeService) {
      // Overlays are cheap; avoid forcing LanguageService creation until needed
      this.typeService.updateFile(filePath, source);
    }

    this.removeFile(filePath);

    const components = parseComponent(source, filePath);
    if (this.typeService && this.typeService.isReady) {
      resolveComponentTypes(components, this.typeService, filePath);
    }
    for (const comp of components) {
      this.components.set(comp.templateName, comp);
    }
    this.fileComponents.set(filePath, components);

    const globals = findGlobalHelpers(source, filePath);
    if (this.typeService && this.typeService.isReady) {
      resolveGlobalHelperTypes(globals, this.typeService, filePath);
    }
    for (const g of globals) {
      this.globalHelpers.set(g.name, g);
    }
    this._fileGlobalHelpers.set(filePath, globals);
  }

  /**
   * Re-index any JS files whose mtime on disk is newer than when we last indexed them.
   */
  refreshStaleFiles() {
    let changed = false;
    for (const filePath of this._mtimes.keys()) {
      try {
        const stat = fs.statSync(filePath);
        const lastIndexed = this._mtimes.get(filePath) || 0;
        if (stat.mtimeMs > lastIndexed) {
          if (this.typeService) this.typeService.invalidateFile(filePath);
          this.indexFile(filePath);
          changed = true;
        }
      } catch {}
    }
    return changed;
  }

  /**
   * Restore components + global helpers from index-cache.json.
   * @param {object[]} cachedComponents
   * @param {object[]} cachedGlobals
   */
  hydrateFromCache(cachedComponents, cachedGlobals) {
    this.components.clear();
    this.fileComponents.clear();
    this.globalHelpers.clear();
    this._fileGlobalHelpers.clear();
    this._mtimes.clear();

    /** @type {Map<string, ComponentInfo[]>} */
    const byFile = new Map();

    if (Array.isArray(cachedComponents)) {
      for (const entry of cachedComponents) {
        if (!entry || !entry.templateName) continue;
        /** @type {ComponentInfo} */
        const comp = {
          className: entry.className || "",
          filePath: entry.filePath || "",
          templateName: entry.templateName,
          helpers: Array.isArray(entry.helpers) ? entry.helpers : [],
          events: Array.isArray(entry.events) ? entry.events : [],
          contextDataFields: Array.isArray(entry.contextDataFields) ? entry.contextDataFields : [],
          parentClass: entry.parentClass ?? null,
          htmlImportPath: entry.htmlImportPath ?? null,
          classRange: entry.classRange || { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
        };
        this.components.set(comp.templateName, comp);
        if (comp.filePath) {
          const list = byFile.get(comp.filePath) || [];
          list.push(comp);
          byFile.set(comp.filePath, list);
          this._mtimes.set(comp.filePath, 0);
        }
      }
    }

    for (const [fp, list] of byFile) {
      this.fileComponents.set(fp, list);
    }

    /** @type {Map<string, GlobalHelperInfo[]>} */
    const globalsByFile = new Map();
    if (Array.isArray(cachedGlobals)) {
      for (const entry of cachedGlobals) {
        if (!entry || !entry.name) continue;
        /** @type {GlobalHelperInfo} */
        const g = {
          name: entry.name,
          filePath: entry.filePath || "",
          range: entry.range || { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
          returnType: entry.returnType,
          documentation: entry.documentation,
          params: entry.params
        };
        this.globalHelpers.set(g.name, g);
        if (g.filePath) {
          const list = globalsByFile.get(g.filePath) || [];
          list.push(g);
          globalsByFile.set(g.filePath, list);
          if (!this._mtimes.has(g.filePath)) this._mtimes.set(g.filePath, 0);
        }
      }
    }
    for (const [fp, list] of globalsByFile) {
      this._fileGlobalHelpers.set(fp, list);
    }
  }

  /**
   * Remove all components from a file.
   * @param {string} filePath
   */
  removeFile(filePath) {
    const existing = this.fileComponents.get(filePath);
    if (existing) {
      for (const comp of existing) {
        this.components.delete(comp.templateName);
      }
      this.fileComponents.delete(filePath);
    }
    const existingGlobals = this._fileGlobalHelpers.get(filePath);
    if (existingGlobals) {
      for (const g of existingGlobals) {
        this.globalHelpers.delete(g.name);
      }
      this._fileGlobalHelpers.delete(filePath);
    }
  }

  /**
   * Get component info by template name.
   * @param {string} templateName
   * @returns {ComponentInfo|undefined}
   */
  getComponent(templateName) {
    return this.components.get(templateName);
  }

  /**
   * Get all template names that have components.
   * @returns {string[]}
   */
  getAllTemplateNames() {
    return Array.from(this.components.keys());
  }

  /**
   * Get all components from a specific file.
   * @param {string} filePath
   * @returns {ComponentInfo[]}
   */
  getComponentsInFile(filePath) {
    return this.fileComponents.get(filePath) || [];
  }

  /**
   * Enrich already-parsed components/globals with TypeService checker types.
   * Yields to the event loop every `batchSize` files so the LSP stays responsive.
   * @param {() => Promise<void>} yieldFn
   * @param {number} [batchSize]
   */
  async enrichTypesChunked(yieldFn, batchSize = 8) {
    if (!this.typeService) return;
    this.typeService.ensureReady();

    const files = new Set([
      ...this.fileComponents.keys(),
      ...this._fileGlobalHelpers.keys()
    ]);

    let n = 0;
    for (const filePath of files) {
      const comps = this.fileComponents.get(filePath);
      if (comps && comps.length) {
        resolveComponentTypes(comps, this.typeService, filePath);
      }
      const globals = this._fileGlobalHelpers.get(filePath);
      if (globals && globals.length) {
        resolveGlobalHelperTypes(globals, this.typeService, filePath);
      }
      n++;
      if (n % batchSize === 0 && yieldFn) {
        await yieldFn();
      }
    }
  }

  /**
   * Get total component count.
   * @returns {number}
   */
  get size() {
    return this.components.size;
  }
}

module.exports = { ComponentIndexer };
