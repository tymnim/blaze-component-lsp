// @ts-check
const { parseHTML, getContextAtPosition } = require("../parsers/spacebarsParser");
const { pathToUri } = require("../utils/uri");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 */

/**
 * Find all references for the identifier at a position.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @param {number} line - 0-based
 * @param {number} column - 0-based
 * @returns {import("vscode-languageserver").Location[] | null}
 */
function getReferences(index, filePath, source, line, column) {
  const templates = parseHTML(source, filePath);
  const { template, expression } = getContextAtPosition(templates, line, column);

  if (!template || !expression) return null;
  if (expression.type === "Comment") return null;

  if (expression.type === "PartialExpression") {
    const refs = index.findTemplateReferences(expression.path);
    return refs.map(ref => ({
      uri: pathToUri(ref.filePath),
      range: {
        start: { line: ref.loc.start.line, character: ref.loc.start.column },
        end: { line: ref.loc.end.line, character: ref.loc.end.column }
      }
    }));
  }

  if (expression.type === "MustacheExpression" || expression.type === "RawExpression") {
    const refs = index.findHelperReferences(expression.path);
    return refs.map(ref => ({
      uri: pathToUri(ref.filePath),
      range: {
        start: { line: ref.loc.start.line, character: ref.loc.start.column },
        end: { line: ref.loc.end.line, character: ref.loc.end.column }
      }
    }));
  }

  return null;
}

module.exports = { getReferences };
