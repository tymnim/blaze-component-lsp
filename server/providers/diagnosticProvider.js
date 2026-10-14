// @ts-check
const { DiagnosticSeverity } = require("vscode-languageserver");
const { parseHTML } = require("../parsers/spacebarsParser");
const {
  walkWithEachScopes,
  resolvePathType,
  isCorrelatedTemplateDataPair,
  classifyTemplateNameType,
  extractTemplateLiteralName,
  contextDataTypeForTemplate,
  hasEachIndex,
  EACH_INDEX
} = require("../typescript/spacebarsTypeScope");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 * @typedef {import("../typescript/spacebarsTypeScope").EachScope} EachScope
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

    const helperNames = new Set(component.helpers.map(h => h.name));
    for (const g of index.getGlobalHelpers()) {
      helperNames.add(g.name);
    }
    const contextFieldNames = new Set(component.contextDataFields.map(f => f.name));

    walkWithEachScopes(template.expressions, (expr, scopes) => {
      if (expr.type === "Comment") return;

      if (expr.type === "PartialExpression") {
        const partialName = expr.path;
        if (partialName === "Template.dynamic") {
          checkTemplateDynamic(index, expr, diagnostics, source, typeSeverity, template.name, helperNames, contextFieldNames, scopes);
          return;
        }
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
            checkPartialArgs(index, partialName, expr, diagnostics, source, typeSeverity, template.name, helperNames, contextFieldNames, scopes);
          }
        }
        return;
      }

      if (expr.type === "BlockExpression" && BUILTIN_HELPERS.has(expr.path)) {
        if (expr.params) {
          for (const param of expr.params) {
            if (param.type === "PathExpression") {
              checkPathKnown(param, diagnostics, template.name, helperNames, contextFieldNames, scopes);
            }
          }
        }
        return;
      }

      if (expr.type === "BlockExpression") {
        const blockTemplate = index.getTemplate(expr.path);
        if (blockTemplate && blockTemplate.isBlockTemplate) {
          checkBlockTemplateArgs(index, expr, diagnostics, source, typeSeverity, template.name, helperNames, contextFieldNames, scopes);
          return;
        }
      }

      if (expr.type === "MustacheExpression" || expr.type === "RawExpression") {
        const name = expr.path;
        if (name === EACH_INDEX) {
          if (!hasEachIndex(scopes)) {
            diagnostics.push({
              range: {
                start: { line: expr.loc.start.line, character: expr.loc.start.column },
                end: { line: expr.loc.end.line, character: expr.loc.end.column }
              },
              severity: DiagnosticSeverity.Warning,
              source: "blaze-component-lsp",
              message: `"${EACH_INDEX}" is only available inside {{#each}}`
            });
          }
          return;
        }
        if (name.includes(".")) {
          // Allow blockParam.prop — only warn if root is unknown and not a block param
          const root = name.split(".")[0];
          const isBlockParam = scopes.some(s => s.param && s.param === root);
          if (!isBlockParam && !helperNames.has(root) && !contextFieldNames.has(root) && !BUILTIN_HELPERS.has(root)) {
            diagnostics.push({
              range: {
                start: { line: expr.loc.start.line, character: expr.loc.start.column },
                end: { line: expr.loc.end.line, character: expr.loc.end.column }
              },
              severity: DiagnosticSeverity.Warning,
              source: "blaze-component-lsp",
              message: `Unknown helper or data field "${root}" in template "${template.name}"`
            });
          }
          return;
        }
        if (BUILTIN_HELPERS.has(name)) return;
        if (scopes.some(s => s.param && s.param === name)) return;

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
    });
  }

  return diagnostics;
}

/**
 * @param {import("../parsers/spacebarsParser").SpacebarsParam} param
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {EachScope[]} scopes
 */
function checkPathKnown(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, scopes) {
  if (!param) return;

  // (helper arg…) — validate helper name + nested path args
  if (param.type === "SubExpression") {
    const helperName = param.value;
    if (helperName && !BUILTIN_HELPERS.has(helperName) && !helperNames.has(helperName) && !contextFieldNames.has(helperName)) {
      diagnostics.push({
        range: {
          start: { line: param.loc.start.line, character: param.loc.start.column },
          end: { line: param.loc.end.line, character: param.loc.end.column }
        },
        severity: DiagnosticSeverity.Warning,
        source: "blaze-component-lsp",
        message: `Unknown helper or data field "${helperName}" in template "${sourceTemplateName}"`
      });
    }
    if (param.params) {
      for (const p of param.params) {
        if (p.type === "PathExpression" || p.type === "SubExpression") {
          checkPathKnown(p, diagnostics, sourceTemplateName, helperNames, contextFieldNames, scopes);
        }
      }
    }
    return;
  }

  if (param.type !== "PathExpression") return;

  const name = param.value;
  if (!name || BUILTIN_HELPERS.has(name)) return;

  if (name === EACH_INDEX) {
    if (!hasEachIndex(scopes)) {
      diagnostics.push({
        range: {
          start: { line: param.loc.start.line, character: param.loc.start.column },
          end: { line: param.loc.end.line, character: param.loc.end.column }
        },
        severity: DiagnosticSeverity.Warning,
        source: "blaze-component-lsp",
        message: `"${EACH_INDEX}" is only available inside {{#each}}`
      });
    }
    return;
  }

  if (name.includes(".")) {
    const root = name.split(".")[0];
    if (scopes.some(s => s.param && s.param === root)) return;
    if (!helperNames.has(root) && !contextFieldNames.has(root)) {
      diagnostics.push({
        range: {
          start: { line: param.loc.start.line, character: param.loc.start.column },
          end: { line: param.loc.end.line, character: param.loc.end.column }
        },
        severity: DiagnosticSeverity.Warning,
        source: "blaze-component-lsp",
        message: `Unknown helper or data field "${root}" in template "${sourceTemplateName}"`
      });
    }
    return;
  }

  if (scopes.some(s => s.param && s.param === name)) return;
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
  }
}

/**
 * Validate {{> Template.dynamic template=... data=...}}.
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 * @param {import("vscode-languageserver").DiagnosticSeverity} typeSeverity
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {EachScope[]} scopes
 */
function checkTemplateDynamic(index, expr, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames, scopes) {
  const hash = expr.hash || {};
  const templateParam = hash.template;
  const dataParam = hash.data;

  if (!templateParam) {
    diagnostics.push({
      range: {
        start: { line: expr.loc.start.line, character: expr.loc.start.column },
        end: { line: expr.loc.end.line, character: expr.loc.end.column }
      },
      severity: typeSeverity,
      source: "blaze-component-lsp",
      message: `Template.dynamic requires a "template" argument`
    });
    return;
  }

  // Correlated each-in pair: skip data/template mismatch
  if (isCorrelatedTemplateDataPair(index, sourceTemplateName, templateParam, dataParam, scopes)) {
    // Still warn if template prop type is plain string
    const tType = resolvePathType(index, sourceTemplateName, templateParam.value, scopes);
    const kind = classifyTemplateNameType(index, tType);
    if (kind === "string") {
      diagnostics.push({
        range: findHashKeyRange(source, expr, "template"),
        severity: DiagnosticSeverity.Warning,
        source: "blaze-component-lsp",
        message: `Template.dynamic "template" is typed as string — prefer import("blaze-component-lsp").Template`
      });
    }
    return;
  }

  /** @type {string|undefined} */
  let concreteName;
  /** @type {string|undefined} */
  let templateTypeStr;

  if (templateParam.type === "StringLiteral") {
    concreteName = templateParam.value;
  } else if (templateParam.type === "PathExpression" || templateParam.type === "SubExpression") {
    checkPathKnown(templateParam, diagnostics, sourceTemplateName, helperNames, contextFieldNames, scopes);
    // SubExpression `(template doc)` → resolve return type of helper `template`
    const pathForType = templateParam.type === "SubExpression"
      ? templateParam.value
      : templateParam.value;
    templateTypeStr = resolvePathType(index, sourceTemplateName, pathForType, scopes);
    const litFromType = extractTemplateLiteralName(templateTypeStr);
    if (litFromType) concreteName = litFromType;

    const kind = classifyTemplateNameType(index, templateTypeStr);
    if (kind === "string") {
      diagnostics.push({
        range: findHashKeyRange(source, expr, "template"),
        severity: DiagnosticSeverity.Warning,
        source: "blaze-component-lsp",
        message: `Template.dynamic "template" is typed as string — prefer import("blaze-component-lsp").Template`
      });
    } else if (kind === "unknown" && templateTypeStr) {
      // leave alone — may still be Template alias we didn't classify
    }
  }

  if (concreteName) {
    if (!index.getTemplate(concreteName)) {
      diagnostics.push({
        range: findHashKeyRange(source, expr, "template"),
        severity: DiagnosticSeverity.Error,
        source: "blaze-component-lsp",
        message: `Template "${concreteName}" is not defined`
      });
      return;
    }

    if (dataParam) {
      const expected = contextDataTypeForTemplate(index, concreteName);
      checkDynamicDataArg(index, dataParam, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames, scopes, expected, concreteName, expr);
    }
    return;
  }

  // Wide Template union / typed Template — if data is present and not correlated, we can't refine
  if (dataParam && (dataParam.type === "PathExpression" || dataParam.type === "SubExpression")) {
    checkPathKnown(dataParam, diagnostics, sourceTemplateName, helperNames, contextFieldNames, scopes);
  }
}

/**
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsParam} dataParam
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} source
 * @param {import("vscode-languageserver").DiagnosticSeverity} typeSeverity
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {EachScope[]} scopes
 * @param {string|undefined} expectedType
 * @param {string} concreteName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expr
 */
function checkDynamicDataArg(index, dataParam, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames, scopes, expectedType, concreteName, expr) {
  if (!expectedType) return;

  if (dataParam.type === "PathExpression") {
    checkPathExpressionValue(dataParam, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `data of Template.dynamic → "${concreteName}"`, scopes);
    return;
  }

  const actualType = LITERAL_TYPE_MAP[dataParam.type];
  if (actualType && !typesAssignable(index, actualType, expectedType)) {
    // Also try assignability against reconstructed object/primitive from index fields
    const fields = index.getComponentForTemplate(concreteName)?.contextDataFields || [];
    let fallbackExpected = expectedType;
    if (fields.length === 1 && fields[0].name === "data") {
      fallbackExpected = fields[0].type;
    }
    if (!typesAssignable(index, actualType, fallbackExpected)) {
      diagnostics.push({
        range: findHashKeyRange(source, expr, "data"),
        severity: typeSeverity,
        source: "blaze-component-lsp",
        message: `Type "${actualType}" is not assignable to ContextData of template "${concreteName}"`
      });
    }
  }
}

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
 * @param {EachScope[]} scopes
 */
function checkPartialArgs(index, partialName, expr, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames, scopes) {
  const targetComponent = index.getComponentForTemplate(partialName);
  const fields = targetComponent ? targetComponent.contextDataFields : [];
  const hasTypeDef = fields.length > 0;
  const isSingleDataField = hasTypeDef && fields.length === 1 && fields[0].name === "data";

  // Positional `{{> tpl expr}}` — expr is the entire ContextData (object or primitive).
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
    const expectedType = contextDataTypeForTemplate(index, partialName);
    if (expectedType) {
      const param = expr.params[0];
      const actualType = LITERAL_TYPE_MAP[param.type];
      if (actualType && !typesAssignable(index, actualType, expectedType)) {
        diagnostics.push({
          range: findParamValueRange(source, expr, param.value),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Type "${actualType}" is not assignable to type "${expectedType}" of template "${partialName}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `template "${partialName}"`, scopes);
      }
    }
    return;
  }

  if (isSingleDataField) return;

  const fieldMap = hasTypeDef ? new Map(fields.map(f => [f.name, f.type])) : null;

  for (const [key, param] of Object.entries(expr.hash || {})) {
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
      if (actualType && expectedType && !typesAssignable(index, actualType, expectedType)) {
        diagnostics.push({
          range: findHashKeyRange(source, expr, key),
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Type "${actualType}" is not assignable to type "${expectedType}" for property "${key}" of template "${partialName}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `property "${key}" of template "${partialName}"`, scopes);
      }
    }
  }
}

/**
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
 * @param {import("../parsers/spacebarsParser").SpacebarsParam} param
 * @param {import("vscode-languageserver").Diagnostic[]} diagnostics
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {ProjectIndex} [index]
 * @param {string} [expectedType]
 * @param {import("vscode-languageserver").DiagnosticSeverity} [typeSeverity]
 * @param {string} [contextLabel]
 * @param {EachScope[]} [scopes]
 */
function checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, contextLabel, scopes = []) {
  const name = param.value;
  if (!name || BUILTIN_HELPERS.has(name)) return;

  checkPathKnown(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, scopes);

  if (!index || !expectedType || !typeSeverity) return;

  let actualType = resolvePathType(index, sourceTemplateName, name, scopes);

  // Fallback for non-dotted helpers without going through scopes
  if (!actualType && !name.includes(".")) {
    const sourceComponent = index.getComponentForTemplate(sourceTemplateName);
    if (sourceComponent) {
      const helper = sourceComponent.helpers.find(h => h.name === name);
      if (helper && helper.returnType) actualType = helper.returnType;
      else {
        const field = sourceComponent.contextDataFields.find(f => f.name === name);
        if (field) actualType = field.type;
      }
    }
    if (!actualType) {
      const globalHelper = index.getGlobalHelper(name);
      if (globalHelper && globalHelper.returnType) actualType = globalHelper.returnType;
    }
  }

  if (actualType && !typesAssignable(index, actualType, expectedType)) {
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
 * @param {import("vscode-languageserver").DiagnosticSeverity} typeSeverity
 * @param {string} sourceTemplateName
 * @param {Set<string>} helperNames
 * @param {Set<string>} contextFieldNames
 * @param {EachScope[]} scopes
 */
function checkBlockTemplateArgs(index, expr, diagnostics, source, typeSeverity, sourceTemplateName, helperNames, contextFieldNames, scopes) {
  const targetComponent = index.getComponentForTemplate(expr.path);
  if (!targetComponent) return;

  const fields = targetComponent.contextDataFields;
  if (fields.length === 0) return;

  const isSingleDataField = fields.length === 1 && fields[0].name === "data";

  // Positional `{{#tpl expr}}` — expr is the entire ContextData.
  if (expr.params && expr.params.length > 0) {
    const expectedType = contextDataTypeForTemplate(index, expr.path);
    if (expectedType) {
      const param = expr.params[0];
      const actualType = LITERAL_TYPE_MAP[param.type];
      if (actualType && !typesAssignable(index, actualType, expectedType)) {
        const range = findParamValueRange(source, expr, param.value);
        diagnostics.push({
          range,
          severity: typeSeverity,
          source: "blaze-component-lsp",
          message: `Type "${actualType}" is not assignable to type "${expectedType}"`
        });
      } else if (param.type === "PathExpression") {
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, expectedType, typeSeverity, `block template "${expr.path}"`, scopes);
      }
    }
    return;
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
        checkPathExpressionValue(param, diagnostics, sourceTemplateName, helperNames, contextFieldNames, index, fieldMap.get(key), typeSeverity, `property "${key}" of block template "${expr.path}"`, scopes);
      }
    }
  }
}

/**
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
 * @param {ProjectIndex} index
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function typesAssignable(index, actual, expected) {
  if (typeof index.isTypeAssignable === "function") {
    return index.isTypeAssignable(actual, expected);
  }
  if (actual === expected) return true;
  const parts = expected.split(/\s*\|\s*/);
  return parts.some(p => p.trim() === actual || p.trim() === "any" || p.trim() === "unknown");
}

module.exports = { getDiagnostics };
