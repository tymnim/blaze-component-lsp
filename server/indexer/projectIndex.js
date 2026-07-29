// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { TemplateIndexer } = require("./templateIndexer");
const { ComponentIndexer } = require("./componentIndexer");

/**
 * @typedef {import("../parsers/spacebarsParser").TemplateBlock} TemplateBlock
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 * @typedef {import("../parsers/componentParser").HelperInfo} HelperInfo
 * @typedef {import("../parsers/componentParser").ContextField} ContextField
 */

const IGNORE_DIRS = new Set([
  "node_modules", ".meteor", ".git", ".deploy",
  "cordova-build-override", "public", "resources"
]);

class ProjectIndex {
  /**
   * @param {string} rootPath - Project root directory
   */
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.templateIndexer = new TemplateIndexer();
    this.componentIndexer = new ComponentIndexer();
    /** @type {Set<string>} */
    this._indexedFiles = new Set();
  }

  /**
   * Perform initial full scan of the project.
   */
  scan() {
    this._scanDirectory(this.rootPath);
  }

  /**
   * Re-index a single file (on change/save).
   * @param {string} filePath - Absolute path
   * @param {string} [source] - File content (read from disk if not provided)
   */
  updateFile(filePath, source) {
    if (filePath.endsWith(".html")) {
      this.templateIndexer.indexFile(filePath, source);
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
      this.componentIndexer.indexFile(filePath, source);
    }
  }

  /**
   * Remove a file from the index.
   * @param {string} filePath
   */
  removeFile(filePath) {
    if (filePath.endsWith(".html")) {
      this.templateIndexer.removeFile(filePath);
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
      this.componentIndexer.removeFile(filePath);
    }
    this._indexedFiles.delete(filePath);
  }

  /**
   * Get all available identifiers for a template (helpers + context data fields).
   * @param {string} templateName
   * @returns {{ helpers: HelperInfo[], contextFields: ContextField[] }}
   */
  getAvailableIdentifiers(templateName) {
    const component = this.componentIndexer.getComponent(templateName);
    if (!component) {
      return { helpers: [], contextFields: [] };
    }
    return {
      helpers: component.helpers,
      contextFields: component.contextDataFields
    };
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
   * Recursively scan a directory for HTML and JS files.
   * @param {string} dirPath
   */
  _scanDirectory(dirPath) {
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

      if (entry.isDirectory()) {
        this._scanDirectory(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".html")) {
          this.templateIndexer.indexFile(fullPath);
          this._indexedFiles.add(fullPath);
        } else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) {
          this.componentIndexer.indexFile(fullPath);
          this._indexedFiles.add(fullPath);
        }
      }
    }
  }
}

module.exports = { ProjectIndex };
