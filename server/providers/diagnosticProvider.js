// @ts-check
const { DiagnosticSeverity } = require("vscode-languageserver");
const { parseHTML, flattenExpressions } = require("../parsers/spacebarsParser");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 */

const BUILTIN_HELPERS = new Set(["if", "unless", "each", "with", "let", "else"]);
const BUILTIN_TEMPLATES = new Set(["Template.dynamic", "Template.contentBlock", "Template.elseBlock", "spinner"]);

/**
 * @typedef {Object} BlazeConfig
 * @prop {boolean} errorOnTypeMismatch
 */

/**
 * Compute diagnostics for an HTML document.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @param {BlazeConfig} [config]
 * @returns {import("vscode-languageserver").Diagnostic[]}
 */
function getDiagnostics(index, filePath, source, config) {
  const typeSeverity = config && config.errorOnTypeMismatch
    ? DiagnosticSeverity.Error
    : DiagnosticSeverity.Warning;
  const templates = parseHTML(source, filePath);
  /** @type {import("vscode-languageserver").Diagnostic[]} */
  const diagnostics = [];

  for (const template of templates) {
    const component = index.getComponentForTemplate(template.name);

    if (!component) {
      diagnostics.push({
        range: {
          start: { line: template.range.start.line, character: template.range.start.column },
          end: { line: template.range.start.line, character: template.range.start.column + template.name.length + 20 }
        },
        severity: DiagnosticSeverity.Information,
        source: "blaze-component-lsp",
        message: `Template "${template.name}" has no BlazeComponent registered`
      });
      continue;
    }

    const allExpressions = flattenExpressions(template.expressions);
    const helperNames = new Set(component.helpers.map(h => h.name));
    for (const g of index.getGlobalHelpers()) {
      helperNames.add(g.name);
    }
    const contextFieldNames = new Set(component.contextDataFields.map(f => f.name));

    for (const expr of allExpressions) {
      if (expr.type === "Comment") continue;

      if (expr.type === "PartialExpression") {
        const partialName = expr.path;
        if (!BUILTIN_TEMPLATES.has(partialName) && !index.getTemplate(partialName)) {
          diagnostics.push({
            range: {
              start: { line: expr.loc.start.line, character: expr.loc.start.column },
              end: { line: expr.loc.end.line, character: expr.loc.end.column }
            },
            severity: DiagnosticSeverity.Error,
            source: "blaze-component-lsp",
            message: `Template "${partialName}" is not defined`
          });
        } else if (!BUILTIN_TEMPLATES.has(partialName)) {
          const hasHash = expr.hash && Object.keys(expr.hash).length > 0;
          const hasParams = expr.params && expr.params.length > 0;
          if (hasHash || hasParams) {
            checkPartialArgs(index, partialName, expr, diagnostics, source, typeSeverity, template.name, helperNames, contextFieldNames);
          }
        }
        continue;
      }

      if (expr.type === "BlockExpression" && BUILTIN_HELPERS.has(expr.path)) {
        if (expr.params) {
          for (const param of expr.params) {
            if (param.type === "PathExpression" && !param.value.includes(".")) {
              const name = param.value;
              if (!BUILTIN_HELPERS.has(name) && !helperNames.has(name) && !contextFieldNames.has(name)) {
                diagnostics.push({
                  range: {
                    start: { line: param.loc.start.line, character: param.loc.start.column },
                    end: { line: param.loc.end.line, character: param.loc.end.column }
                  },
                  severity: DiagnosticSeverity.Warning,
                  source: "blaze-component-lsp",
                  message: `Unknown helper or data field "${name}" in template "${template.name}"`
                });
              }
            }
          }
        }
        continue;
      }

      if (expr.type === "BlockExpression") {
        const blockTemplate = index.getTemplate(expr.path);
        if (blockTemplate && blockTemplate.isBlockTemplate) {
          checkBlockTemplateArgs(index, expr, diagnostics, source, typeSeverity, template.name, helperNames, contextFieldNames);
          continue;
        }
      }

      if (expr.type === "MustacheExpression" || expr.type === "RawExpression") {
        const name = expr.path;
        if (name.includes(".")) continue; // Dotted paths (e.g., item.name) — skip
        if (BUILTIN_HELPERS.has(name)) continue;

        if (!helperNames.has(name) && !contextFieldNames.has(name)) {
          diagnostics.push({
            range: {
              start: { line: expr.loc.start.line, character: expr.loc.start.column },
              end: { line: expr.loc.end.line, character: expr.loc.end.column }
            },
            severity: DiagnosticSeverity.Warning,
            source: "blaze-component-lsp",
            message: `Unknown helper or data field "${name}" in template "${template.name}"`
          });
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Check hash arguments passed to a partial against its context data type.
 * @param {ProjectIndex} index
 * @param {string} partialName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 */
/**
 * @param {ProjectIndex} index
 * @param {string} partialName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 */
/**
 * @param {ProjectIndex} index
 * @param {string} partialName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 * @param {import("vscode-languageserver").DiagnosticSeverity} typeSeverity
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 */
function checkPartialArgs(index, partialName, expr, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames) {
  const targetComponent = index.getComponentForTemplate(partialName);
  const fields = targetComponent ? targetComponent.contextDataFields : [];
  const hasTypeDef = fields.length > 0;
  const isSingleDataField = hasTypeDef && fields.length === 1 && fields[0].name === "data";

  // Positional args: {{> template arg}}
  if (expr.params && expr.params.length > 0) {
    if (!hasTypeDef) {
      for (const param of expr.params) {
        diagnostics.push({
          range: findParamValueRange(source, expr, param.value),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Cannot pass arguments to template "${partialName}" — type is unknown`
        });
      }
      return;
    }
    if (isSingleDataField) {
      const expectedType = fields[0].type;
      const param = expr.params[0];
      const actualType = LITERAL_TYPE_MAP[param.type];
      if (actualType && !typeMatches(actualType, expectedType)) {
        diagnostics.push({
          range: findParamValueRange(source, expr, param.value),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Type "${actualType}" is not assignable to type "${expectedType}" of template "${partialName}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `template "${partialName}"`);
      }
      return;
    }
  }

  if (isSingleDataField) return;

  // Hash args: {{> template key=value}}
  const fieldMap = hasTypeDef ? new Map(fields.map(f => [f.name, f.type])) : null;

  for (const [key, param] of Object.entries(expr.hash)) {
    if (!fieldMap) {
      diagnostics.push({
        range: findHashKeyRange(source, expr, key),
        severity: typeSeverity,
        source: "blaze-component-lsp",
        message: `Cannot pass property "${key}" to template "${partialName}" — type is unknown`
      });
    } else if (!fieldMap.has(key)) {
      diagnostics.push({
        range: findHashKeyRange(source, expr, key),
        severity: typeSeverity,
        source: "blaze-component-lsp",
        message: `"${key}" does not exist on context data of template "${partialName}"`
      });
    } else {
      const expectedType = fieldMap.get(key);
      const actualType = LITERAL_TYPE_MAP[param.type];
      if (actualType && expectedType && !typeMatches(actualType, expectedType)) {
        diagnostics.push({
          range: findHashKeyRange(source, expr, key),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Type "${actualType}" is not assignable to type "${expectedType}" for property "${key}" of template "${partialName}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `property "${key}" of template "${partialName}"`);
      }
    }
  }
}

/**
 * Find the source range of `key=value` within an expression.
 * @param {string} source
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {string} key
 * @returns {import("vscode-languageserver").Range}
 */
function findHashKeyRange(source, expr, key) {
  const lines = source.split("\n");
  const pattern = new RegExp(`\\b${key}\\s*=\\s*("[^"]*"|'[^']*'|\\S+)`);

  for (let line = expr.loc.start.line; line <= expr.loc.end.line; line++) {
    const lineText = lines[line] || "";
    const match = pattern.exec(lineText);
    if (match) {
      return {
        start: { line, character: match.index },
        end: { line, character: match.index + match[0].length }
      };
    }
  }

  return {
    start: { line: expr.loc.start.line, character: expr.loc.start.column },
    end: { line: expr.loc.end.line, character: expr.loc.end.column }
  };
}

/**
 * Validate a PathExpression value: check it exists and optionally check return type.
 * @param {import("../parsers/spacebarsParser").SpacebarsParam} param
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {ProjectIndex} [index]
 * @param {string} [expectedType]
 * @param {import("vscode-languageserver").DiagnosticSeverity} [typeSeverity]
 * @param {string} [contextLabel] - e.g. 'property "checked" of template "foo"'
 */
function checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, contextLabel) {
  const name = param.value;
  if (!name || name.includes(".") || BUILTIN_HELPERS.has(name)) return;

  if (!helperNames.has(name) && !contextFieldNames.has(name)) {
    diagnostics.push({
      range: {
        start: { line: param.loc.start.line, character: param.loc.start.column },
        end: { line: param.loc.end.line, character: param.loc.end.column }
      },
      severity: DiagnosticSeverity.Warning,
      source: "blaze-component-lsp",
      message: `Unknown helper or data field "${name}" in template "${sourceTemplateName}"`
    });
    return;
  }

  if (!index || !expectedType || !typeSeverity) return;

  const sourceComponent = index.getComponentForTemplate(sourceTemplateName);
  if (!sourceComponent) return;

  let actualType;
  const helper = sourceComponent.helpers.find(h => h.name === name);
  if (helper && helper.returnType) {
    actualType = helper.returnType;
  } else {
    const field = sourceComponent.contextDataFields.find(f => f.name === name);
    if (field) {
      actualType = field.type;
    } else {
      const globalHelper = index.getGlobalHelper(name);
      if (globalHelper && globalHelper.returnType) {
        actualType = globalHelper.returnType;
      }
    }
  }

  if (actualType && !typeMatches(actualType, expectedType)) {
    const label = contextLabel || `expected "${expectedType}"`;
    diagnostics.push({
      range: {
        start: { line: param.loc.start.line, character: param.loc.start.column },
        end: { line: param.loc.end.line, character: param.loc.end.column }
      },
      severity: typeSeverity,
      source: "blaze-component-lsp",
      message: `Type "${actualType}" (from "${name}") is not assignable to type "${expectedType}"${contextLabel ? " for " + contextLabel : ""}`
    });
  }
}

/** @type {Record<string, string>} */
const LITERAL_TYPE_MAP = {
  StringLiteral: "string",
  NumberLiteral: "number",
  BooleanLiteral: "boolean"
};

/**
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 */
/**
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 * @param {import("vscode-languageserver").DiagnosticSeverity} typeSeverity
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 */
function checkBlockTemplateArgs(index, expr, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames) {
  const targetComponent = index.getComponentForTemplate(expr.path);
  if (!targetComponent) return;

  const fields = targetComponent.contextDataFields;
  if (fields.length === 0) return;

  const isSingleDataField = fields.length === 1 && fields[0].name === "data";

  if (isSingleDataField && expr.params.length > 0) {
    const expectedType = fields[0].type;
    const param = expr.params[0];
    const actualType = LITERAL_TYPE_MAP[param.type];
    if (actualType && !typeMatches(actualType, expectedType)) {
      const range = findParamValueRange(source, expr, param.value);
      diagnostics.push({
        range,
        severity: typeSeverity,
        source: "blaze-component-lsp",
        message: `Type "${actualType}" is not assignable to type "${expectedType}"`
      });
    } else if (param.type === "PathExpression") {
      checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `block template "${expr.path}"`);
    }
  }

  if (!isSingleDataField && expr.hash && Object.keys(expr.hash).length > 0) {
    const fieldMap = new Map(fields.map(f => [f.name, f.type]));
    for (const [key, param] of Object.entries(expr.hash)) {
      if (!fieldMap.has(key)) {
        diagnostics.push({
          range: findHashKeyRange(source, expr, key),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `"${key}" does not exist on context data of block template "${expr.path}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, fieldMap.get(key), typeSeverity, `property "${key}" of block template "${expr.path}"`);
      }
    }
  }
}

/**
 * Find the range of a positional param value in the source.
 * @param {string} source
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {string} value
 * @returns {import("vscode-languageserver").Range}
 */
function findParamValueRange(source, expr, value) {
  const lines = source.split("\n");
  const line = expr.loc.start.line;
  const lineText = lines[line] || "";
  const exprText = lineText.slice(expr.loc.start.column);
  const idx = exprText.indexOf(value);
  if (idx !== -1) {
    const start = expr.loc.start.column + idx;
    return {
      start: { line, character: start },
      end: { line, character: start + value.length }
    };
  }
  return {
    start: { line: expr.loc.start.line, character: expr.loc.start.column },
    end: { line: expr.loc.end.line, character: expr.loc.end.column }
  };
}

/**
 * Check if an actual type is compatible with an expected type.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function typeMatches(actual, expected) {
  if (actual === expected) return true;
  const parts = expected.split(/\s*\|\s*/);
  return parts.some(p => p.trim() === actual || p.trim() === "any" || p.trim() === "unknown");
}

module.exports = { getDiagnostics };
