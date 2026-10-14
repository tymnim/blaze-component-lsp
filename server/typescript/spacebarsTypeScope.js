// @ts-check

/**
 * Helpers for resolving Spacebars expression types with each-in block scopes.
 *
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 * @typedef {import("../parsers/spacebarsParser").SpacebarsNode} SpacebarsNode
 * @typedef {import("../parsers/spacebarsParser").SpacebarsParam} SpacebarsParam
 *
 * @typedef {Object} EachScope
 * @prop {string} param - Block param name (e.g. "tab")
 * @prop {string} collection - Collection path (e.g. "tabs")
 */

/**
 * Walk expressions depth-first, tracking each-in scopes.
 * @param {SpacebarsNode[]} expressions
 * @param {(expr: SpacebarsNode, scopes: EachScope[]) => void} visit
 * @param {EachScope[]} [scopes]
 */
function walkWithEachScopes(expressions, visit, scopes = []) {
  for (const expr of expressions) {
    visit(expr, scopes);

    if (expr.type === "BlockExpression" && expr.path === "each" && expr.blockParams && expr.blockParams.length > 0) {
      const collection = expr.params && expr.params[0] ? expr.params[0].value : "";
      const childScopes = [
        ...scopes,
        { param: expr.blockParams[0], collection }
      ];
      if (expr.children) walkWithEachScopes(expr.children, visit, childScopes);
      // else branch of each typically has no item binding
      if (expr.inverse) walkWithEachScopes(expr.inverse, visit, scopes);
    } else {
      if (expr.children) walkWithEachScopes(expr.children, visit, scopes);
      if (expr.inverse) walkWithEachScopes(expr.inverse, visit, scopes);
    }
  }
}

/**
 * Resolve the type string of a helper / context field / dotted each-in path.
 * @param {ProjectIndex} index
 * @param {string} sourceTemplateName
 * @param {string} pathValue - e.g. "tabs", "tab.template", "isChecked"
 * @param {EachScope[]} scopes
 * @returns {string|undefined}
 */
function resolvePathType(index, sourceTemplateName, pathValue, scopes) {
  if (!pathValue) return undefined;

  // Dotted: blockParam.prop
  if (pathValue.includes(".")) {
    const parts = pathValue.split(".");
    if (parts.length !== 2) return undefined;
    const [root, prop] = parts;
    const scope = [...scopes].reverse().find(s => s.param === root);
    if (!scope) return undefined;

    const elementType = resolveCollectionElementType(index, sourceTemplateName, scope.collection, scopes.slice(0, scopes.indexOf(scope)));
    if (!elementType) return undefined;

    return resolvePropertyTypeFromObjectTypeString(elementType, prop);
  }

  // Bare block param
  const scope = [...scopes].reverse().find(s => s.param === pathValue);
  if (scope) {
    return resolveCollectionElementType(index, sourceTemplateName, scope.collection, scopes.slice(0, scopes.indexOf(scope)));
  }

  const component = index.getComponentForTemplate(sourceTemplateName);
  if (component) {
    const helper = component.helpers.find(h => h.name === pathValue);
    if (helper && helper.returnType) return helper.returnType;
    const field = component.contextDataFields.find(f => f.name === pathValue);
    if (field) return field.type;
  }
  const globalHelper = index.getGlobalHelper(pathValue);
  if (globalHelper && globalHelper.returnType) return globalHelper.returnType;

  return undefined;
}

/**
 * Get the element type of a collection expression (helper returning an array).
 * @param {ProjectIndex} index
 * @param {string} sourceTemplateName
 * @param {string} collectionPath
 * @param {EachScope[]} scopes
 * @returns {string|undefined}
 */
function resolveCollectionElementType(index, sourceTemplateName, collectionPath, scopes) {
  const collType = resolvePathType(index, sourceTemplateName, collectionPath, scopes);
  if (!collType) return undefined;
  return elementTypeFromArrayTypeString(collType);
}

/**
 * Extract element type from strings like `Tab[]`, `Array<Tab>`, `(A | B)[]`.
 * @param {string} typeStr
 * @returns {string|undefined}
 */
function elementTypeFromArrayTypeString(typeStr) {
  const trimmed = typeStr.trim();
  // Array<T>
  const arrayGeneric = trimmed.match(/^Array\s*<\s*([\s\S]+)\s*>$/);
  if (arrayGeneric) return arrayGeneric[1].trim();

  // T[]
  if (trimmed.endsWith("[]")) {
    return trimmed.slice(0, -2).trim().replace(/^\(/, "").replace(/\)$/, "");
  }

  // ReadonlyArray<T>
  const ro = trimmed.match(/^ReadonlyArray\s*<\s*([\s\S]+)\s*>$/);
  if (ro) return ro[1].trim();

  return undefined;
}

/**
 * Best-effort property lookup on an object type string.
 * Handles `{ template: T, data: U, name: string }` and simple interfaces we can't parse deeply.
 * @param {string} objectTypeStr
 * @param {string} prop
 * @returns {string|undefined}
 */
function resolvePropertyTypeFromObjectTypeString(objectTypeStr, prop) {
  const s = objectTypeStr.trim();

  // Inline object type
  if (s.startsWith("{") && s.endsWith("}")) {
    const body = s.slice(1, -1);
    // Match `prop: Type` or `prop?: Type` — type runs until next `,` or `;` at depth 0, or end
    const re = new RegExp(
      `(?:^|[,;])\\s*${escapeRegExp(prop)}\\??\\s*:\\s*`,
      "m"
    );
    const m = re.exec(body);
    if (!m) return undefined;
    const start = m.index + m[0].length;
    let depth = 0;
    let i = start;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "{" || ch === "<" || ch === "(") depth++;
      else if (ch === "}" || ch === ">" || ch === ")") depth--;
      else if ((ch === "," || ch === ";") && depth === 0) break;
    }
    return body.slice(start, i).trim() || undefined;
  }

  // Named type alias — we cannot expand without the checker; return a synthetic path hint
  // Callers that need Template correlation use hasTemplateDataShape / isCorrelatedTemplateDataPair
  return undefined;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if an element type string looks like `{ template: ..., data: ... }` (structural).
 * @param {string|undefined} elementTypeStr
 * @returns {boolean}
 */
const PRIMITIVE_TYPE_NAMES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "void", "null", "undefined",
  "object", "symbol", "bigint", "Object", "String", "Number", "Boolean"
]);

function hasTemplateDataShape(elementTypeStr) {
  if (!elementTypeStr) return false;
  const s = elementTypeStr.trim();
  // Inline object with both props
  if (s.includes("{") && /(?:^|[,;{\s])template\??\s*:/.test(s) && /(?:^|[,;{\s])data\??\s*:/.test(s)) {
    return true;
  }
  if (/TemplateEntry\b/.test(s)) return true;
  // Named typedefs (Tab, Panel, …) — treat as potentially correlated when we can't expand
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !PRIMITIVE_TYPE_NAMES.has(s)) return true;
  return false;
}

/**
 * True when template= and data= are property accesses on the same each-in block param
 * and that param's element type has a template/data shape.
 * @param {ProjectIndex} index
 * @param {string} sourceTemplateName
 * @param {SpacebarsParam|undefined} templateParam
 * @param {SpacebarsParam|undefined} dataParam
 * @param {EachScope[]} scopes
 * @returns {boolean}
 */
function isCorrelatedTemplateDataPair(index, sourceTemplateName, templateParam, dataParam, scopes) {
  if (!templateParam || !dataParam) return false;
  if (templateParam.type !== "PathExpression" || dataParam.type !== "PathExpression") return false;

  const tParts = templateParam.value.split(".");
  const dParts = dataParam.value.split(".");
  if (tParts.length !== 2 || dParts.length !== 2) return false;
  if (tParts[0] !== dParts[0]) return false;
  if (tParts[1] !== "template" || dParts[1] !== "data") return false;

  const root = tParts[0];
  const scope = [...scopes].reverse().find(s => s.param === root);
  if (!scope) return false;

  const elementType = resolveCollectionElementType(
    index,
    sourceTemplateName,
    scope.collection,
    scopes.slice(0, Math.max(0, scopes.indexOf(scope)))
  );

  return hasTemplateDataShape(elementType);
}

/**
 * Whether a type string looks like our Template type (or a known template literal / union).
 * @param {ProjectIndex} index
 * @param {string|undefined} typeStr
 * @returns {"template"|"literal"|"string"|"unknown"}
 */
function classifyTemplateNameType(index, typeStr) {
  if (!typeStr) return "unknown";
  const s = typeStr.trim();

  if (s === "string") return "string";
  if (/\bTemplate\b/.test(s) && !/HTMLTemplateElement/.test(s)) return "template";
  if (/keyof\s+TemplateContextMap/.test(s)) return "template";
  if (/import\s*\(\s*["']blaze-component-lsp["']\s*\)\s*\.\s*Template/.test(s)) return "template";

  // Single string literal
  const lit = s.match(/^"([^"]+)"$/) || s.match(/^'([^']+)'$/);
  if (lit) {
    return index.getTemplate(lit[1]) ? "literal" : "string";
  }

  // Union of string literals
  if (/^("[^"]+"\s*\|\s*)+"[^"]+"$/.test(s) || /^('[^']+'\s*\|\s*)+'[^']+'$/.test(s)) {
    return "template";
  }

  // Known template name as bare identifier type unlikely; check membership of quoted unions loosely
  const known = index.getAllTemplateNames();
  if (known.some(n => s.includes(`"${n}"`) || s.includes(`'${n}'`))) return "template";

  return "unknown";
}

/**
 * Extract a concrete template name from a string literal type or StringLiteral param.
 * @param {string|undefined} typeOrValue
 * @returns {string|undefined}
 */
function extractTemplateLiteralName(typeOrValue) {
  if (!typeOrValue) return undefined;
  const m = typeOrValue.trim().match(/^["']([^"']+)["']$/);
  return m ? m[1] : undefined;
}

/**
 * Build expected ContextData type string for a template name.
 * Prefers an inline type from the index (works without tsconfig paths).
 * @param {ProjectIndex} index
 * @param {string} templateName
 * @returns {string|undefined}
 */
function contextDataTypeForTemplate(index, templateName) {
  const component = index.getComponentForTemplate(templateName);
  const fields = component ? component.contextDataFields : [];
  if (fields.length === 1 && fields[0].name === "data") {
    return fields[0].type;
  }
  if (fields.length > 0) {
    const { contextFieldsToTypeString } = require("./templateRegistryEmitter");
    return contextFieldsToTypeString(fields);
  }
  const quoted = JSON.stringify(templateName);
  return `import("blaze-component-lsp").ContextDataFrom<${quoted}>`;
}

module.exports = {
  walkWithEachScopes,
  resolvePathType,
  resolveCollectionElementType,
  elementTypeFromArrayTypeString,
  resolvePropertyTypeFromObjectTypeString,
  hasTemplateDataShape,
  isCorrelatedTemplateDataPair,
  classifyTemplateNameType,
  extractTemplateLiteralName,
  contextDataTypeForTemplate
};
