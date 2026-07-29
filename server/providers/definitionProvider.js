// @ts-check
const { parseHTML, getContextAtPosition } = require("../parsers/spacebarsParser");
const { pathToUri } = require("../utils/uri");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 */

/**
 * Provide go-to-definition for a position in an HTML document.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @param {number} line - 0-based
 * @param {number} column - 0-based
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getDefinition(index, filePath, source, line, column) {
  const templates = parseHTML(source, filePath);
  const { template, expression } = getContextAtPosition(templates, line, column);

  if (!template || !expression) return null;
  if (expression.type === "Comment") return null;

  if (expression.type === "PartialExpression") {
    return getPartialDefinition(index, expression);
  }

  return getIdentifierDefinition(index, template.name, expression);
}

/**
 * Get definition for a partial inclusion — go to the template definition.
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expression
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getPartialDefinition(index, expression) {
  const templateName = expression.path;
  if (templateName === "Template.dynamic") return null;

  /** @type {import("vscode-languageserver").Location[]} */
  const locations = [];

  const template = index.getTemplate(templateName);
  if (template && template.filePath) {
    locations.push({
      uri: pathToUri(template.filePath),
      range: {
        start: { line: template.range.start.line, character: template.range.start.column },
        end: { line: template.range.start.line, character: template.range.start.column + templateName.length + 20 }
      }
    });
  }

  const component = index.getComponentForTemplate(templateName);
  if (component) {
    locations.push({
      uri: pathToUri(component.filePath),
      range: {
        start: { line: component.classRange.start.line, character: component.classRange.start.column },
        end: { line: component.classRange.start.line, character: component.classRange.start.column + component.className.length + 6 }
      }
    });
  }

  return locations.length > 0 ? locations : null;
}

/**
 * Get definition for a helper or context data field.
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expression
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getIdentifierDefinition(index, templateName, expression) {
  const identifierName = expression.path;
  const component = index.getComponentForTemplate(templateName);
  if (!component) return null;

  const helper = component.helpers.find(h => h.name === identifierName);
  if (helper) {
    return [{
      uri: pathToUri(component.filePath),
      range: {
        start: { line: helper.range.start.line, character: helper.range.start.column },
        end: { line: helper.range.end.line, character: helper.range.end.column }
      }
    }];
  }

  const field = component.contextDataFields.find(f => f.name === identifierName);
  if (field) {
    return [{
      uri: pathToUri(component.filePath),
      range: {
        start: { line: field.range.start.line, character: field.range.start.column },
        end: { line: field.range.end.line, character: field.range.end.column }
      }
    }];
  }

  return null;
}

module.exports = { getDefinition };
