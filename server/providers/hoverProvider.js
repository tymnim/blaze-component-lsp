// @ts-check
const { parseHTML, getContextAtPosition, flattenExpressions } = require("../parsers/spacebarsParser");
const {
  getEachScopesAtPosition,
  hasEachIndex,
  resolvePathType,
  EACH_INDEX
} = require("../typescript/spacebarsTypeScope");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 */

const BUILTIN_BLOCK_HELPERS = {
  if: "Conditionally renders the block content if the argument is truthy.",
  unless: "Renders the block content if the argument is falsy (inverse of #if).",
  each: "Iterates over an array or cursor. Use `{{#each item in collection}}` for named iteration.",
  with: "Changes the data context to the argument for the block content.",
  let: "Introduces local template variables."
};

/**
 * Provide hover information for a position in an HTML document.
 * @param {ProjectIndex} index
 * @param {string} filePath
 * @param {string} source
 * @param {number} line - 0-based
 * @param {number} column - 0-based
 * @returns {{ contents: string, range?: import("../parsers/spacebarsParser").SourceRange } | null}
 */
function getHover(index, filePath, source, line, column) {
  const templates = parseHTML(source, filePath);
  const { template, expression } = getContextAtPosition(templates, line, column);

  if (!template || !expression) return null;

  if (expression.type === "Comment") return null;

  if (expression.type === "PartialExpression") {
    return getPartialHover(index, expression);
  }

  if (expression.type === "BlockExpression") {
    const builtin = BUILTIN_BLOCK_HELPERS[expression.path];
    if (builtin) {
      return {
        contents: `**\`{{#${expression.path}}}\`** — Built-in block helper\n\n${builtin}`,
        range: expression.loc
      };
    }
  }

  const eachScopes = getEachScopesAtPosition(template.expressions, line, column);
  return getIdentifierHover(index, template.name, expression, eachScopes);
}

/**
 * Get hover for a partial inclusion.
 * @param {ProjectIndex} index
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expression
 * @returns {{ contents: string, range?: import("../parsers/spacebarsParser").SourceRange } | null}
 */
function getPartialHover(index, expression) {
  const templateName = expression.path;

  if (templateName === "Template.dynamic") {
    return {
      contents: "**`{{> Template.dynamic}}`** — Dynamically renders a template by name at runtime.",
      range: expression.loc
    };
  }

  const template = index.getTemplate(templateName);
  const component = index.getComponentForTemplate(templateName);

  /** @type {string[]} */
  const parts = [`**Template: \`${templateName}\`**`];

  if (template && template.filePath) {
    parts.push(`\nDefined in: \`${template.filePath}\``);
  }

  if (component) {
    parts.push(`\nComponent: \`${component.className}\` in \`${component.filePath}\``);

    if (component.contextDataFields.length > 0) {
      parts.push("\n**Context Data:**");
      for (const field of component.contextDataFields) {
        const desc = field.description ? ` — ${field.description}` : "";
        parts.push(`- \`${field.name}\`: \`${field.type}\`${desc}`);
      }
    }
  }

  if (!template && !component) {
    parts.push("\n⚠️ Template not found in project");
  }

  return { contents: parts.join("\n"), range: expression.loc };
}

/**
 * Get hover for a mustache identifier (helper or data field).
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @param {import("../parsers/spacebarsParser").SpacebarsNode} expression
 * @returns {{ contents: string, range?: import("../parsers/spacebarsParser").SourceRange } | null}
 */
function getIdentifierHover(index, templateName, expression, eachScopes = []) {
  const identifierName = expression.path;

  if (identifierName === EACH_INDEX) {
    if (!hasEachIndex(eachScopes)) return null;
    return {
      contents: `**\`${EACH_INDEX}\`** — \`number\`\n\n0-based index of the current item in \`{{#each}}\`.`,
      range: expression.loc
    };
  }

  // each-in block param
  if (eachScopes.some(s => s.param && s.param === identifierName)) {
    const type = resolvePathType(index, templateName, identifierName, eachScopes);
    const scope = [...eachScopes].reverse().find(s => s.param === identifierName);
    /** @type {string[]} */
    const parts = [`**Block param: \`${identifierName}\`**`];
    if (type) parts.push(`\nType: \`${type}\``);
    if (scope) parts.push(`\nFrom \`{{#each ${identifierName} in ${scope.collection || "…"}}}\``);
    return { contents: parts.join("\n"), range: expression.loc };
  }

  const component = index.getComponentForTemplate(templateName);

  if (component) {
    const helper = component.helpers.find(h => h.name === identifierName);
    if (helper) {
      /** @type {string[]} */
      const parts = [`**Helper: \`${helper.name}\`**`];
      if (helper.returnType) parts.push(`\nReturns: \`${helper.returnType}\``);
      if (helper.documentation) parts.push(`\n${helper.documentation}`);
      if (helper.params && helper.params.length > 0) {
        const paramLines = helper.params.map(p => {
          const type = p.type ? `: \`${p.type}\`` : "";
          const desc = p.description ? ` — ${p.description}` : "";
          return `- \`${p.name}\`${type}${desc}`;
        });
        parts.push("\n**Params**\n\n" + paramLines.join("\n"));
      }
      parts.push(`\nMethod: \`${helper.methodName}\` in \`${component.className}\``);
      parts.push(`\nFile: \`${component.filePath}\``);
      return { contents: parts.join("\n"), range: expression.loc };
    }

    const field = component.contextDataFields.find(f => f.name === identifierName);
    if (field) {
      /** @type {string[]} */
      const parts = [`**Context Data: \`${field.name}\`**`];
      parts.push(`\nType: \`${field.type}\``);
      if (field.description) parts.push(`\n${field.description}`);
      return { contents: parts.join("\n"), range: expression.loc };
    }
  }

  const globalHelper = index.getGlobalHelper(identifierName);
  if (globalHelper) {
    /** @type {string[]} */
    const parts = [`**Global helper: \`${globalHelper.name}\`**`];
    if (globalHelper.returnType) parts.push(`\nReturns: \`${globalHelper.returnType}\``);
    if (globalHelper.documentation) parts.push(`\n${globalHelper.documentation}`);
    if (globalHelper.params && globalHelper.params.length > 0) {
      const paramLines = globalHelper.params.map(p => {
        const type = p.type ? `: \`${p.type}\`` : "";
        const desc = p.description ? ` — ${p.description}` : "";
        return `- \`${p.name}\`${type}${desc}`;
      });
      parts.push("\n**Params**\n\n" + paramLines.join("\n"));
    }
    parts.push(`\nFile: \`${globalHelper.filePath}\``);
    return { contents: parts.join("\n"), range: expression.loc };
  }

  return null;
}

module.exports = { getHover };
