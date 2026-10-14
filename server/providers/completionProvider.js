// @ts-check
const { CompletionItemKind } = require("vscode-languageserver");
const { parseHTML, getContextAtPosition, flattenExpressions } = require("../parsers/spacebarsParser");
const {
  getEachScopesAtPosition,
  hasEachIndex,
  EACH_INDEX
} = require("../typescript/spacebarsTypeScope");

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

  const lines = source.split("\n");
  const lineText = lines[line] || "";
  const textBeforeCursorOnLine = lineText.slice(0, column);

  const textBeforeCursor = getTextBeforeCursorInExpression(lines, line, column);
  const eachScopes = getEachScopesAtPosition(template.expressions, line, column);

  if (isInsidePartialTag(textBeforeCursor)) {
    if (isAfterPartialName(textBeforeCursor)) {
      if (isAfterEquals(textBeforeCursor)) {
        return getHelperAndDataCompletions(index, template.name, { eachScopes });
      }
      // Hash keys from the target template's ContextData, plus positional
      // helpers/fields from the *current* template (e.g. {{> cardsContainer recruits}}).
      return [
        ...getPartialHashCompletions(index, textBeforeCursor),
        ...getHelperAndDataCompletions(index, template.name, { includeBuiltins: false, eachScopes })
      ];
    }
    return getTemplateNameCompletions(index);
  }

  if (isInsideBlockOpen(textBeforeCursor)) {
    const blockStart = textBeforeCursorOnLine.lastIndexOf("{{#");
    if (blockStart !== -1) {
      const nameStart = blockStart + 3;
      const editRange = {
        start: { line, character: nameStart },
        end: { line, character: column }
      };
      return getBlockCompletions(index, template.name, editRange);
    }
    return getBlockCompletions(index, template.name);
  }

  if (isInsideMustache(textBeforeCursor)) {
    return getHelperAndDataCompletions(index, template.name, { eachScopes });
  }

  return [];
}

/**
 * Build the text before cursor spanning back to the nearest unclosed `{{` expression.
 * This handles multiline partials/blocks.
 * @param {string[]} lines
 * @param {number} line
 * @param {number} column
 * @returns {string}
 */
function getTextBeforeCursorInExpression(lines, line, column) {
  let result = lines[line].slice(0, column);

  let depth = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] === "}" && i > 0 && result[i - 1] === "}") { depth++; i--; }
    else if (result[i] === "{" && i > 0 && result[i - 1] === "{") { depth--; i--; if (depth < 0) return result; }
  }

  for (let l = line - 1; l >= Math.max(0, line - 30); l--) {
    const prevLine = lines[l];
    result = prevLine + "\n" + result;

    for (let i = prevLine.length - 1; i >= 0; i--) {
      if (prevLine[i] === "}" && i > 0 && prevLine[i - 1] === "}") { depth++; i--; }
      else if (prevLine[i] === "{" && i > 0 && prevLine[i - 1] === "{") { depth--; i--; if (depth < 0) return result; }
    }
  }

  return result;
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
  const lastEq = afterOpen.lastIndexOf("=");
  if (lastEq === -1) return false;
  const afterEq = afterOpen.slice(lastEq + 1);
  // If afterEq contains a complete value (non-whitespace) followed by whitespace
  // and then more text (or just whitespace), we're in key position
  if (/\S+\s+\S/.test(afterEq)) return false;
  if (/\S+\s+$/.test(afterEq)) return false;
  return true;
}

/**
 * Check if the cursor is inside a `{{#...}}` block open expression.
 * @param {string} textBefore
 * @returns {boolean}
 */
function isInsideBlockOpen(textBefore) {
  const lastOpen = textBefore.lastIndexOf("{{#");
  if (lastOpen === -1) return false;
  const closeAfterOpen = textBefore.indexOf("}}", lastOpen + 3);
  return closeAfterOpen === -1;
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
  if (afterOpen.startsWith(">") || afterOpen.startsWith("!") || afterOpen.startsWith("/") || afterOpen.startsWith("#")) return false;
  const closeAfterOpen = textBefore.indexOf("}}", lastOpen + 2);
  return closeAfterOpen === -1;
}

/**
 * Get template name completions for `{{> ...}}`.
 * @param {ProjectIndex} index
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getTemplateNameCompletions(index) {
  /** @type {import("vscode-languageserver").CompletionItem[]} */
  const items = index.getAllTemplateNames().map(name => {
    const component = index.getComponentForTemplate(name);
    let detail = "Template<unknown>";
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

  items.push({
    label: "Template.dynamic",
    kind: CompletionItemKind.Module,
    detail: "Template<{template: Template, data: ContextDataFrom<Template>}>",
    documentation: {
      kind: "markdown",
      value: "Dynamically render a template by name.\n\n- `template`: `import(\"blaze-component-lsp\").Template` — template name\n- `data`: `ContextDataFrom<T>` — context data for that template\n\nPrefer typed helpers or correlated `{ template, data }` pairs from `{{#each}}`."
    },
    data: { type: "builtin", name: "Template.dynamic" }
  });

  items.push({
    label: "Template.contentBlock",
    kind: CompletionItemKind.Module,
    detail: "Block content",
    documentation: {
      kind: "markdown",
      value: "Renders the content block passed to this block template.\n\n`{{#myBlock}}` **this content** `{{/myBlock}}`"
    },
    data: { type: "builtin", name: "Template.contentBlock" }
  });

  items.push({
    label: "Template.elseBlock",
    kind: CompletionItemKind.Module,
    detail: "Else block content",
    documentation: {
      kind: "markdown",
      value: "Renders the else block passed to this block template.\n\n`{{#myBlock}}...{{else}}` **this content** `{{/myBlock}}`"
    },
    data: { type: "builtin", name: "Template.elseBlock" }
  });

  return items;
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
 * @param {{ includeBuiltins?: boolean, eachScopes?: import("../typescript/spacebarsTypeScope").EachScope[] }} [options]
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getHelperAndDataCompletions(index, templateName, options = {}) {
  const includeBuiltins = options.includeBuiltins !== false;
  const eachScopes = options.eachScopes || [];
  const { helpers, contextFields } = index.getAvailableIdentifiers(templateName);

  /** @type {import("vscode-languageserver").CompletionItem[]} */
  const items = [];

  if (hasEachIndex(eachScopes)) {
    items.push({
      label: EACH_INDEX,
      kind: CompletionItemKind.Variable,
      detail: "number",
      documentation: {
        kind: "markdown",
        value: "0-based index of the current item in `{{#each}}`."
      },
      data: { type: "builtin", name: EACH_INDEX }
    });

    // Suggest each-in block params alongside helpers/fields
    const seenParams = new Set();
    for (let i = eachScopes.length - 1; i >= 0; i--) {
      const param = eachScopes[i].param;
      if (!param || seenParams.has(param)) continue;
      seenParams.add(param);
      items.push({
        label: param,
        kind: CompletionItemKind.Variable,
        detail: `each item (${eachScopes[i].collection || "collection"})`,
        documentation: {
          kind: "markdown",
          value: `Block parameter from \`{{#each ${param} in ${eachScopes[i].collection || "…"}}}\`.`
        },
        data: { type: "blockParam", name: param }
      });
    }
  }

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

  if (includeBuiltins) {
    for (const builtin of ["if", "unless", "each", "with", "let"]) {
      items.push({
        label: builtin,
        kind: CompletionItemKind.Keyword,
        detail: "Block helper",
        data: { type: "builtin", name: builtin }
      });
    }
  }

  return items;
}

/**
 * Get completions for `{{#...}}` — built-in block helpers + block templates.
 * @param {ProjectIndex} index
 * @param {string} currentTemplateName
 * @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} [editRange]
 * @returns {import("vscode-languageserver").CompletionItem[]}
 */
function getBlockCompletions(index, currentTemplateName, editRange) {
  /** @type {import("vscode-languageserver").CompletionItem[]} */
  const items = [];

  for (const builtin of ["if", "unless", "each", "with", "let"]) {
    /** @type {import("vscode-languageserver").CompletionItem} */
    const item = {
      label: builtin,
      kind: CompletionItemKind.Keyword,
      detail: "Block helper",
      data: { type: "builtin", name: builtin }
    };
    if (editRange) item.textEdit = { range: editRange, newText: builtin };
    items.push(item);
  }

  for (const name of index.getBlockTemplateNames()) {
    const component = index.getComponentForTemplate(name);
    const template = index.getTemplate(name);
    const hasElse = template ? template.includedTemplates.includes("Template.elseBlock") : false;

    let detail = "Block template<unknown>";
    let documentation;

    if (component && component.contextDataFields.length > 0) {
      const fields = component.contextDataFields;
      const isSingleDataField = fields.length === 1 && fields[0].name === "data";

      if (isSingleDataField) {
        detail = `Block template<${fields[0].type}>`;
      } else {
        const inlineProps = fields.map(f => `${f.name}: ${f.type}`).join(", ");
        detail = inlineProps.length <= 150 ? `Block template<{${inlineProps}}>` : "Block template<ContextData>";
      }
    }

    const docParts = [];
    if (hasElse) docParts.push("Supports `{{else}}` block");
    if (component && component.contextDataFields.length > 0) {
      const fields = component.contextDataFields;
      const isSingleDataField = fields.length === 1 && fields[0].name === "data";
      if (!isSingleDataField) {
        const docLines = fields.map(f => {
          const desc = f.description ? ` — ${f.description}` : "";
          return `- \`${f.name}\`: \`${f.type}\`${desc}`;
        });
        docParts.push("**ContextData**\n\n" + docLines.join("\n"));
      }
    }
    if (docParts.length > 0) {
      documentation = { kind: "markdown", value: docParts.join("\n\n") };
    }

    /** @type {import("vscode-languageserver").CompletionItem} */
    const item = {
      label: name,
      kind: CompletionItemKind.Snippet,
      detail,
      documentation,
      data: { type: "blockTemplate", name }
    };
    if (editRange) item.textEdit = { range: editRange, newText: name };
    items.push(item);
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
  isInsideBlockOpen,
  isAfterPartialName,
  isAfterEquals,
  getTemplateNameCompletions,
  getHelperAndDataCompletions,
  getPartialHashCompletions,
  getBlockCompletions
};
