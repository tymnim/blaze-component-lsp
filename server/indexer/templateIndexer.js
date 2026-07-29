// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("../parsers/spacebarsParser");

/**
 * @typedef {import("../parsers/spacebarsParser").TemplateBlock} TemplateBlock
 */

class TemplateIndexer {
  constructor() {
    /** @type {Map<string, TemplateBlock>} name → TemplateBlock */
    this.templates = new Map();
    /** @type {Map<string, TemplateBlock[]>} filePath → TemplateBlocks[] */
    this.fileTemplates = new Map();
  }

  /**
   * Index a single HTML file.
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

    const templates = parseHTML(source, filePath);
    for (const tpl of templates) {
      tpl.filePath = filePath;
      this.templates.set(tpl.name, tpl);
    }
    this.fileTemplates.set(filePath, templates);
  }

  /**
   * Remove all templates from a file.
   * @param {string} filePath
   */
  removeFile(filePath) {
    const existing = this.fileTemplates.get(filePath);
    if (existing) {
      for (const tpl of existing) {
        this.templates.delete(tpl.name);
      }
      this.fileTemplates.delete(filePath);
    }
  }

  /**
   * Get a template by name.
   * @param {string} name
   * @returns {TemplateBlock|undefined}
   */
  getTemplate(name) {
    return this.templates.get(name);
  }

  /**
   * Get all template names.
   * @returns {string[]}
   */
  getAllTemplateNames() {
    return Array.from(this.templates.keys());
  }

  /**
   * Get all templates from a specific file.
   * @param {string} filePath
   * @returns {TemplateBlock[]}
   */
  getTemplatesInFile(filePath) {
    return this.fileTemplates.get(filePath) || [];
  }

  /**
   * Get total template count.
   * @returns {number}
   */
  get size() {
    return this.templates.size;
  }
}

module.exports = { TemplateIndexer };
