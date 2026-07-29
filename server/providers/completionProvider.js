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
      if (isAfterEquals(textBeforeCursor)) {
        return getHelperAndDataCompletions(index, template.name);
      }
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
 * Check if the cursor is after `=` in a partial's hash arguments (value position).
 * e.g. `{{> myTemplate checked=` or `{{> myTemplate name=som`
 * @param {string} textBefore
 * @returns {boolean}
 */
function isAfterEquals(textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{>");
  if (lastOpen === -1) return false;
  const afterOpen = textBefore.slice(lastOpen + 3);
  // Check if the last non-whitespace token before cursor ends with = or follows =
  const lastEq = afterOpen.lastIndexOf("=");
  if (lastEq === -1) return false;
  const afterEq = afterOpen.slice(lastEq + 1);
  // If there's no space after = (or only the value being typed), we're in value position
  // If there's a complete value followed by a space, we're back in key position
  return !/\S+\s+$/.test(afterEq);
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
  return index.getAllTemplateNames().map(name => {
    const component = index.getComponentForTemplate(name);
    let detail = "Template";
    let documentation;

    if (component && component.contextDataFields.length > 0) {
      const fields = component.contextDataFields;
      const isSingleDataField = fields.length === 1 && fields[0].name === "data";

      if (isSingleDataField) {
        detail = `Template<${fields[0].type}>`;
        documentation = {
          kind: "markdown",
          value: `\`${fields[0].type}\``
        };
      } else {
        const inlineProps = fields.map(f => `${f.name}: ${f.type}`).join(", ");
        const inlineType = `{${inlineProps}}`;

        if (inlineType.length <= 200) {
          detail = `Template<${inlineType}>`;
        } else {
          detail = "Template<ContextData>";
        }

        const docLines = fields.map(f => {
          const desc = f.description ? ` — ${f.description}` : "";
          return `- \`${f.name}\`: \`${f.type}\`${desc}`;
        });
        documentation = {
          kind: "markdown",
          value: "**ContextData**\n\n" + docLines.join("\n")
        };
      }
    }

    return {
      label: name,
      kind: CompletionItemKind.Module,
      detail,
      documentation,
      data: { type: "template", name }
    };
  });
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
    const paramSig = formatHelperParams(helper.params);
    const returnSig = helper.returnType ? ` → ${helper.returnType}` : "";
    const detail = `(${paramSig})${returnSig}`;

    let documentation;
    if (helper.documentation || (helper.params && helper.params.length > 0)) {
      const parts = [];
      if (helper.documentation) parts.push(helper.documentation);
      if (helper.params && helper.params.length > 0) {
        const paramLines = helper.params.map(p => {
          const type = p.type ? `: \`${p.type}\`` : "";
          const desc = p.description ? ` — ${p.description}` : "";
          return `- \`${p.name}\`${type}${desc}`;
        });
        parts.push("**Params**\n\n" + paramLines.join("\n"));
      }
      documentation = { kind: "markdown", value: parts.join("\n\n") };
    }

    items.push({
      label: helper.name,
      kind: CompletionItemKind.Function,
      detail,
      documentation,
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

/**
 * Format helper params into a signature string.
 * @param {import("../parsers/componentParser").HelperParam[]|undefined} params
 * @returns {string}
 */
function formatHelperParams(params) {
  if (!params || params.length === 0) return "";
  return params.map(p => p.type ? `${p.name}: ${p.type}` : p.name).join(", ");
}

module.exports = {
  getCompletions,
  isInsidePartialTag,
  isInsideMustache,
  isAfterPartialName,
  isAfterEquals,
  getTemplateNameCompletions,
  getHelperAndDataCompletions,
  getPartialHashCompletions
};
