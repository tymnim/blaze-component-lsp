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
   * Restore templates from index-cache.json (no HTML re-parse).
   * Expressions are empty until a background scan / file open re-parses.
   * @param {object[]} cached
   */
  hydrateFromCache(cached) {
    this.templates.clear();
    this.fileTemplates.clear();
    if (!Array.isArray(cached)) return;

    /** @type {Map<string, TemplateBlock[]>} */
    const byFile = new Map();

    for (const entry of cached) {
      if (!entry || !entry.name) continue;
      /** @type {TemplateBlock} */
      const tpl = {
        name: entry.name,
        range: entry.range || { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
        content: "",
        contentStartLine: 0,
        contentStartColumn: 0,
        expressions: [],
        includedTemplates: Array.isArray(entry.includedTemplates) ? entry.includedTemplates : [],
        isBlockTemplate: !!entry.isBlockTemplate,
        filePath: entry.filePath || ""
      };
      this.templates.set(tpl.name, tpl);
      if (tpl.filePath) {
        const list = byFile.get(tpl.filePath) || [];
        list.push(tpl);
        byFile.set(tpl.filePath, list);
      }
    }

    for (const [fp, list] of byFile) {
      this.fileTemplates.set(fp, list);
    }
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
   * Get all block template names (templates using Template.contentBlock or Template.elseBlock).
   * @returns {string[]}
   */
  getBlockTemplateNames() {
    /** @type {string[]} */
    const names = [];
    for (const [name, tpl] of this.templates) {
      if (tpl.isBlockTemplate) names.push(name);
    }
    return names;
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
