// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { parseComponent } = require("../parsers/componentParser");

/**
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 */

class ComponentIndexer {
  constructor() {
    /** @type {Map<string, ComponentInfo>} templateName → ComponentInfo */
    this.components = new Map();
    /** @type {Map<string, ComponentInfo[]>} filePath → ComponentInfo[] */
    this.fileComponents = new Map();
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

    this.removeFile(filePath);

    const components = parseComponent(source, filePath);
    for (const comp of components) {
      this.components.set(comp.templateName, comp);
    }
    this.fileComponents.set(filePath, components);
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
