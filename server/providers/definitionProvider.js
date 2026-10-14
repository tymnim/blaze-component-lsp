// @ts-check
const { parseHTML, getContextAtPosition, isInsideRange } = require("../parsers/spacebarsParser");
const { pathToUri } = require("../utils/uri");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 * @typedef {import("../parsers/spacebarsParser").SpacebarsNode} SpacebarsNode
 * @typedef {import("../parsers/spacebarsParser").SpacebarsParam} SpacebarsParam
 */

const BUILTIN_BLOCK_HELPERS = new Set(["if", "unless", "each", "with", "let"]);
const BUILTIN_TEMPLATES = new Set(["Template.dynamic", "Template.contentBlock", "Template.elseBlock", "spinner"]);

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
  const { template, expression, context } = getContextAtPosition(templates, line, column);

  if (!template || !expression) return null;
  if (expression.type === "Comment") return null;

  // Helpers / context fields used as hash values or positional args
  // e.g. {{> cardsContainer recruits}} or {{> toggle checked=isChecked}}
  if (context === "hash" || context === "params") {
    const paramDef = getDefinitionForParamAtPosition(index, template.name, expression, line, column);
    if (paramDef) return paramDef;
  }

  // Hash keys on partials / block templates → target ContextData field in JS
  if (expression.type === "PartialExpression" || expression.type === "BlockExpression") {
    const keyDef = getHashKeyDefinitionAtPosition(index, expression, source, line, column);
    if (keyDef) return keyDef;
  }

  if (expression.type === "PartialExpression") {
    return getPartialDefinition(index, expression);
  }

  if (expression.type === "BlockExpression") {
    if (BUILTIN_BLOCK_HELPERS.has(expression.path)) return null;
    return getPartialDefinition(index, expression);
  }

  return lookupIdentifierDefinition(index, template.name, expression.path);
}

/**
 * Get definition for a partial inclusion — go to the template definition.
 * @param {ProjectIndex} index
 * @param {SpacebarsNode} expression
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getPartialDefinition(index, expression) {
  const templateName = expression.path;
  if (BUILTIN_TEMPLATES.has(templateName)) return null;

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
 * Resolve definition for a hash/positional param under the cursor.
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @param {SpacebarsNode} expression
 * @param {number} line
 * @param {number} column
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getDefinitionForParamAtPosition(index, templateName, expression, line, column) {
  const param = findParamAtPosition(expression, line, column);
  if (!param) return null;
  return getDefinitionForParam(index, templateName, param, line, column);
}

/**
 * @param {SpacebarsNode} expression
 * @param {number} line
 * @param {number} column
 * @returns {SpacebarsParam|null}
 */
function findParamAtPosition(expression, line, column) {
  for (const key of Object.keys(expression.hash || {})) {
    const param = expression.hash[key];
    if (param && isInsideRange(param.loc, line, column)) return param;
  }
  for (const param of expression.params || []) {
    if (isInsideRange(param.loc, line, column)) return param;
  }
  return null;
}

/**
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @param {SpacebarsParam} param
 * @param {number} line
 * @param {number} column
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getDefinitionForParam(index, templateName, param, line, column) {
  if (param.type === "PathExpression") {
    return lookupIdentifierDefinition(index, templateName, param.value);
  }

  if (param.type === "SubExpression") {
    for (const nested of param.params || []) {
      if (isInsideRange(nested.loc, line, column)) {
        return getDefinitionForParam(index, templateName, nested, line, column);
      }
    }
    for (const key of Object.keys(param.hash || {})) {
      const nested = param.hash[key];
      if (nested && isInsideRange(nested.loc, line, column)) {
        return getDefinitionForParam(index, templateName, nested, line, column);
      }
    }
    // Cursor on the subexpression helper name, e.g. (template doc)
    return lookupIdentifierDefinition(index, templateName, param.value);
  }

  return null;
}

/**
 * If the cursor is on a hash key name (`checked=`), jump to that ContextData field on the target.
 * @param {ProjectIndex} index
 * @param {SpacebarsNode} expression
 * @param {string} source
 * @param {number} line
 * @param {number} column
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getHashKeyDefinitionAtPosition(index, expression, source, line, column) {
  const targetName = expression.path;
  if (!targetName || BUILTIN_TEMPLATES.has(targetName) || BUILTIN_BLOCK_HELPERS.has(targetName)) {
    return null;
  }

  const hash = expression.hash || {};
  const keys = Object.keys(hash);
  if (keys.length === 0) return null;

  const component = index.getComponentForTemplate(targetName);
  if (!component) return null;

  const lines = source.split("\n");
  const lineText = lines[line] || "";

  for (const key of keys) {
    const re = new RegExp(`\\b${escapeRegExp(key)}\\s*=`, "g");
    let match;
    while ((match = re.exec(lineText)) !== null) {
      const keyStart = match.index;
      const keyEnd = keyStart + key.length;
      if (column >= keyStart && column <= keyEnd) {
        // Ensure this match falls inside the expression span
        if (!isInsideRange(expression.loc, line, keyStart)) continue;
        const field = component.contextDataFields.find(f => f.name === key);
        if (!field || !field.range) return null;
        return [rangeToLocation(component.filePath, field.range)];
      }
    }
  }

  return null;
}

/**
 * Look up a helper or context data field (or global helper) by name.
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @param {string|undefined} identifierName
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function lookupIdentifierDefinition(index, templateName, identifierName) {
  if (!identifierName) return null;

  // Dotted path — jump to the root identifier when known
  const rootName = identifierName.includes(".") ? identifierName.split(".")[0] : identifierName;
  if (!rootName) return null;

  const component = index.getComponentForTemplate(templateName);
  if (component) {
    const helper = component.helpers.find(h => h.name === rootName);
    if (helper && helper.range) {
      return [rangeToLocation(component.filePath, helper.range)];
    }

    const field = component.contextDataFields.find(f => f.name === rootName);
    if (field && field.range) {
      return [rangeToLocation(component.filePath, field.range)];
    }
  }

  const globalHelper = index.getGlobalHelper(rootName);
  if (globalHelper && globalHelper.range && globalHelper.filePath) {
    return [rangeToLocation(globalHelper.filePath, globalHelper.range)];
  }

  return null;
}

/**
 * @param {string} filePath
 * @param {{ start: { line: number, column: number }, end: { line: number, column: number } }} range
 * @returns {import("vscode-languageserver").Location}
 */
function rangeToLocation(filePath, range) {
  return {
    uri: pathToUri(filePath),
    range: {
      start: { line: range.start.line, character: range.start.column },
      end: { line: range.end.line, character: range.end.column }
    }
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { getDefinition };
