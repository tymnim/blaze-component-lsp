// @ts-check
const { DiagnosticSeverity } = require("vscode-languageserver");
const { parseHTML, flattenExpressions } = require("../parsers/spacebarsParser");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 */

const BUILTIN_HELPERS = new Set(["if", "unless", "each", "with", "let", "else"]);
const BUILTIN_TEMPLATES = new Set(["Template.dynamic", "spinner"]);

/**
 * Compute diagnostics for an HTML document.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @returns {import("vscode-languageserver").Diagnostic[]}
 */
function getDiagnostics(index, filePath, source) {
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
        }
        continue;
      }

      if (expr.type === "BlockExpression" && BUILTIN_HELPERS.has(expr.path)) {
        continue;
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

module.exports = { getDiagnostics };
