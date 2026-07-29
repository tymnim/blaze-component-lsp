// @ts-check
const { CompletionItemKind } = require("vscode-languageserver");
const { parseHTML, getContextAtPosition, flattenExpressions } = require("../parsers/spacebarsParser");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 * @typedef {import("../parsers/spacebarsParser").TemplateBlock} TemplateBlock
 */

/**
 * Provide completion items for a position in an HTML document.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @param {number} line - 0-based
 * @param {number} column - 0-based
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getCompletions(index, filePath, source, line, column) {
  const templates = parseHTML(source, filePath);
  const { template, expression, context } = getContextAtPosition(templates, line, column);

  if (!template) return [];

  const lineText = source.split("\n")[line] || "";
  const textBeforeCursor = lineText.slice(0, column);

  if (isInsidePartialTag(textBeforeCursor)) {
    if (isAfterPartialName(textBeforeCursor)) {
      return getPartialHashCompletions(index, textBeforeCursor);
    }
    return getTemplateNameCompletions(index);
  }

  if (isInsideMustache(textBeforeCursor)) {
    return getHelperAndDataCompletions(index, template.name);
  }

  return [];
}

/**
 * Check if the cursor is inside a `{{> ...}}` expression.
 * @param {string} textBefore
 * @returns {boolean}
 */
function isInsidePartialTag(textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{>");
  if (lastOpen === -1) return false;
  const closeAfterOpen = textBefore.indexOf("}}", lastOpen + 3);
  return closeAfterOpen === -1;
}

/**
 * Check if the cursor is after the partial name (i.e., in hash arguments area).
 * @param {string} textBefore
 * @returns {boolean}
 */
function isAfterPartialName(textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{>");
  if (lastOpen === -1) return false;
  const afterOpen = textBefore.slice(lastOpen + 3);
  const trimmed = afterOpen.trimStart();
  return /\S\s/.test(trimmed);
}

/**
 * Check if the cursor is inside a `{{ ... }}` mustache expression.
 * @param {string} textBefore
 * @returns {boolean}
 */
function isInsideMustache(textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{");
  if (lastOpen === -1) return false;
  const afterOpen = textBefore.slice(lastOpen + 2);
  if (afterOpen.startsWith(">") || afterOpen.startsWith("!") || afterOpen.startsWith("/")) return false;
  const closeAfterOpen = textBefore.indexOf("}}", lastOpen + 2);
  return closeAfterOpen === -1;
}

/**
 * Get template name completions for `{{> ...}}`.
 * @param {ProjectIndex} index
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getTemplateNameCompletions(index) {
  return index.getAllTemplateNames().map(name => ({
    label: name,
    kind: CompletionItemKind.Module,
    detail: "Template",
    data: { type: "template", name }
  }));
}

/**
 * Get hash argument completions for a partial inclusion.
 * Suggests context data fields of the target template's component.
 * @param {ProjectIndex} index
 * @param {string} textBefore
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getPartialHashCompletions(index, textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{>");
  const afterOpen = textBefore.slice(lastOpen + 3).trim();
  const templateName = afterOpen.split(/\s/)[0];

  if (!templateName) return [];

  const component = index.getComponentForTemplate(templateName);
  if (!component) return [];

  return component.contextDataFields.map(field => ({
    label: field.name,
    kind: CompletionItemKind.Field,
    detail: field.type,
    documentation: field.description || undefined,
    insertText: `${field.name}=`,
    data: { type: "contextField", name: field.name }
  }));
}

/**
 * Get helper and context data field completions for `{{...}}`.
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getHelperAndDataCompletions(index, templateName) {
  const { helpers, contextFields } = index.getAvailableIdentifiers(templateName);

  /** @type {import("vscode-languageserver").CompletionItem[]} */
  const items = [];

  for (const helper of helpers) {
    items.push({
      label: helper.name,
      kind: CompletionItemKind.Function,
      detail: helper.returnType ? `→ ${helper.returnType}` : "Helper (unknown type)",
      documentation: helper.documentation || undefined,
      data: { type: "helper", name: helper.name, templateName }
    });
  }

  for (const field of contextFields) {
    items.push({
      label: field.name,
      kind: CompletionItemKind.Field,
      detail: field.type,
      documentation: field.description || undefined,
      data: { type: "contextField", name: field.name, templateName }
    });
  }

  // Add built-in block helpers
  for (const builtin of ["if", "unless", "each", "with", "let"]) {
    items.push({
      label: builtin,
      kind: CompletionItemKind.Keyword,
      detail: "Block helper",
      data: { type: "builtin", name: builtin }
    });
  }

  return items;
}

module.exports = {
  getCompletions,
  isInsidePartialTag,
  isInsideMustache,
  isAfterPartialName,
  getTemplateNameCompletions,
  getHelperAndDataCompletions,
  getPartialHashCompletions
};
