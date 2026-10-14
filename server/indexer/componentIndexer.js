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
      this.typeService.updateFile(filePath, source);
    }

    this.removeFile(filePath);

    const components = parseComponent(source, filePath);
    if (this.typeService) {
      resolveComponentTypes(components, this.typeService, filePath);
    }
    for (const comp of components) {
      this.components.set(comp.templateName, comp);
    }
    this.fileComponents.set(filePath, components);

    const globals = findGlobalHelpers(source, filePath);
    if (this.typeService) {
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
   * Get total component count.
   * @returns {number}
   */
  get size() {
    return this.components.size;
  }
}

module.exports = { ComponentIndexer };
