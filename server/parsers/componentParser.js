// @ts-check
const ts = require("typescript");

/**
 * @typedef {{ line: number, column: number }} Position
 * @typedef {{ start: Position, end: Position }} SourceRange
 *
 * @typedef {Object} HelperParam
 * @prop {string} name
 * @prop {string} [type]
 * @prop {string} [description]
 *
 * @typedef {Object} HelperInfo
 * @prop {string} name
 * @prop {string} methodName
 * @prop {SourceRange} range
 * @prop {string} [returnType]
 * @prop {string} [documentation]
 * @prop {HelperParam[]} [params]
 *
 * @typedef {Object} EventInfo
 * @prop {string} selector
 * @prop {string} methodName
 * @prop {SourceRange} range
 *
 * @typedef {Object} ContextField
 * @prop {string} name
 * @prop {string} type
 * @prop {string} [description]
 * @prop {SourceRange} range
 *
 * @typedef {Object} ComponentInfo
 * @prop {string} className
 * @prop {string} filePath
 * @prop {string} templateName
 * @prop {HelperInfo[]} helpers
 * @prop {EventInfo[]} events
 * @prop {ContextField[]} contextDataFields
 * @prop {string|null} parentClass
 * @prop {string|null} htmlImportPath
 * @prop {SourceRange} classRange
 *
 * @typedef {Object} GlobalHelperInfo
 * @prop {string} name
 * @prop {string} filePath
 * @prop {SourceRange} range
 * @prop {string} [returnType]
 * @prop {string} [documentation]
 * @prop {HelperParam[]} [params]
 */

/**
 * Parse a JavaScript file and extract BlazeComponent information.
 * @param {string} source - File content
 * @param {string} filePath - File path (for error reporting and position mapping)
 * @returns {ComponentInfo[]}
 */
function parseComponent(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  /** @type {ComponentInfo[]} */
  const components = [];

  const classes = findClasses(sourceFile);
  const registrations = findExplicitRegistrations(sourceFile);
  const htmlImports = findHTMLImports(sourceFile);
  const typedefs = findTypedefsFromJSDoc(sourceFile, source);

  for (const cls of classes) {
    const decoratorReg = findDecoratorRegistration(cls, sourceFile);
    const explicitReg = registrations.find(r => r.className === cls.name);
    const templateName = decoratorReg || (explicitReg ? explicitReg.templateName : null);

    if (!templateName) continue;

    const helpers = [
      ...extractHelperMap(cls, sourceFile),
      ...extractDecoratedHelpers(cls, sourceFile)
    ];
    const events = [
      ...extractEventMap(cls, sourceFile),
      ...extractDecoratedEvents(cls, sourceFile)
    ];

    const parentClass = getParentClassName(cls);
    const contextDataFields = resolveContextData(cls, typedefs, source, sourceFile);

    const helperDocs = extractHelperDocs(cls, sourceFile, source);
    for (const helper of helpers) {
      const doc = helperDocs.get(helper.methodName);
      if (doc) {
        if (doc.returnType) helper.returnType = doc.returnType;
        if (doc.documentation) helper.documentation = doc.documentation;
        if (doc.params) helper.params = doc.params;
      }
    }

    components.push({
      className: cls.name,
      filePath,
      templateName,
      helpers,
      events,
      contextDataFields,
      parentClass: parentClass === "BlazeComponent" ? null : parentClass,
      htmlImportPath: htmlImports[0] || null,
      classRange: nodeRange(cls.node, sourceFile)
    });
  }

  return components;
}

/**
 * @param {ts.SourceFile} sourceFile
 * @returns {{ name: string, node: ts.ClassDeclaration }[]}
 */
function findClasses(sourceFile) {
  /** @type {{ name: string, node: ts.ClassDeclaration }[]} */
  const classes = [];

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      classes.push({ name: node.name.text, node });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return classes;
}

/**
 * Find `@Component(Template.X)` decorator on a class.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @returns {string|null}
 */
function findDecoratorRegistration(cls, sourceFile) {
  // TS 5.x: decorators can be in node.modifiers or node.decorators
  const decorators = getDecorators(cls.node);

  for (const dec of decorators) {
    const expr = dec.expression;
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      if (ts.isIdentifier(callee) && callee.text === "Component") {
        const arg = expr.arguments[0];
        if (arg && ts.isPropertyAccessExpression(arg)) {
          return arg.name.text;
        }
      }
    }
  }
  return null;
}

/**
 * Get decorators from a node, handling both old and new TS AST shapes.
 * @param {ts.Node} node
 * @returns {ts.Decorator[]}
 */
function getDecorators(node) {
  // TS 5.x merged decorators into modifiers
  if (node.modifiers) {
    return /** @type {ts.Decorator[]} */ (
      node.modifiers.filter(m => m.kind === ts.SyntaxKind.Decorator)
    );
  }
  // @ts-ignore — older TS versions
  if (node.decorators) {
    // @ts-ignore
    return node.decorators;
  }
  return [];
}

/**
 * Find `BlazeComponent.register(Template.X, ClassName)` calls.
 * @param {ts.SourceFile} sourceFile
 * @returns {{ templateName: string, className: string }[]}
 */
function findExplicitRegistrations(sourceFile) {
  /** @type {{ templateName: string, className: string }[]} */
  const regs = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "register" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "BlazeComponent"
      ) {
        const [templateArg, classArg] = node.arguments;
        if (templateArg && ts.isPropertyAccessExpression(templateArg) && classArg) {
          const templateName = templateArg.name.text;
          let className = "";
          if (ts.isIdentifier(classArg)) {
            className = classArg.text;
          }
          regs.push({ templateName, className });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return regs;
}

/**
 * Find `import "./something.html"` statements.
 * @param {ts.SourceFile} sourceFile
 * @returns {string[]}
 */
function findHTMLImports(sourceFile) {
  /** @type {string[]} */
  const imports = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier) && specifier.text.endsWith(".html")) {
        imports.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

/**
 * Extract helpers from `static HelperMap()`.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @returns {HelperInfo[]}
 */
function extractHelperMap(cls, sourceFile) {
  /** @type {HelperInfo[]} */
  const helpers = [];

  for (const member of cls.node.members) {
    if (
      ts.isMethodDeclaration(member) &&
      member.name && ts.isIdentifier(member.name) &&
      member.name.text === "HelperMap" &&
      hasStaticModifier(member)
    ) {
      const body = member.body;
      if (!body) continue;

      for (const stmt of body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) {
          if (ts.isArrayLiteralExpression(stmt.expression)) {
            for (const elem of stmt.expression.elements) {
              if (ts.isStringLiteral(elem)) {
                const methodNode = findMethodByName(cls.node, elem.text);
                helpers.push({
                  name: elem.text,
                  methodName: elem.text,
                  range: methodNode ? nodeRange(methodNode, sourceFile) : nodeRange(elem, sourceFile)
                });
              }
            }
          } else if (ts.isObjectLiteralExpression(stmt.expression)) {
            for (const prop of stmt.expression.properties) {
              if (ts.isPropertyAssignment(prop) && prop.name) {
                const key = ts.isStringLiteral(prop.name) ? prop.name.text : (ts.isIdentifier(prop.name) ? prop.name.text : null);
                const val = ts.isStringLiteral(prop.initializer) ? prop.initializer.text : null;
                if (key && val) {
                  const methodNode = findMethodByName(cls.node, val);
                  helpers.push({
                    name: key,
                    methodName: val,
                    range: methodNode ? nodeRange(methodNode, sourceFile) : nodeRange(prop, sourceFile)
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return helpers;
}

/**
 * Extract helpers from `@Helper` decorated methods.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @returns {HelperInfo[]}
 */
function extractDecoratedHelpers(cls, sourceFile) {
  /** @type {HelperInfo[]} */
  const helpers = [];

  for (const member of cls.node.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const decs = getDecorators(member);
      for (const dec of decs) {
        if (ts.isIdentifier(dec.expression) && dec.expression.text === "Helper") {
          helpers.push({
            name: member.name.text,
            methodName: member.name.text,
            range: nodeRange(member, sourceFile)
          });
        }
      }
    }
  }

  return helpers;
}

/**
 * Extract events from `static EventMap()`.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @returns {EventInfo[]}
 */
function extractEventMap(cls, sourceFile) {
  /** @type {EventInfo[]} */
  const events = [];

  for (const member of cls.node.members) {
    if (
      ts.isMethodDeclaration(member) &&
      member.name && ts.isIdentifier(member.name) &&
      member.name.text === "EventMap" &&
      hasStaticModifier(member)
    ) {
      const body = member.body;
      if (!body) continue;

      for (const stmt of body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
          for (const prop of stmt.expression.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name) {
              const selector = ts.isStringLiteral(prop.name) ? prop.name.text : null;
              const methodName = ts.isStringLiteral(prop.initializer) ? prop.initializer.text : null;
              if (selector && methodName) {
                const methodNode = findMethodByName(cls.node, methodName);
                events.push({
                  selector,
                  methodName,
                  range: methodNode ? nodeRange(methodNode, sourceFile) : nodeRange(prop, sourceFile)
                });
              }
            }
          }
        }
      }
    }
  }

  return events;
}

/**
 * Extract events from `@Event("selector")` decorated methods.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @returns {EventInfo[]}
 */
function extractDecoratedEvents(cls, sourceFile) {
  /** @type {EventInfo[]} */
  const events = [];

  for (const member of cls.node.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const decs = getDecorators(member);
      for (const dec of decs) {
        if (ts.isCallExpression(dec.expression)) {
          const callee = dec.expression.expression;
          if (ts.isIdentifier(callee) && callee.text === "Event") {
            const arg = dec.expression.arguments[0];
            if (arg && ts.isStringLiteral(arg)) {
              events.push({
                selector: arg.text,
                methodName: member.name.text,
                range: nodeRange(member, sourceFile)
              });
            }
          }
        }
      }
    }
  }

  return events;
}

/**
 * Extract JSDoc @typedef blocks from the source.
 * @param {ts.SourceFile} sourceFile
 * @param {string} source
 * @returns {Map<string, ContextField[]>}
 */
function findTypedefsFromJSDoc(sourceFile, source) {
  /** @type {Map<string, ContextField[]>} */
  const typedefs = new Map();

  const typedefRegex = /@typedef\s+\{Object\}\s+(\w+)/g;
  const propRegex = /@prop\s+\{([^}]+)\}\s+(\[?\w+\]?)\s*(?:-\s*(.*))?/g;

  let match;
  while ((match = typedefRegex.exec(source)) !== null) {
    const typedefName = match[1];
    const typedefStart = match.index;

    // Find the full JSDoc comment containing this @typedef
    const commentStart = source.lastIndexOf("/**", typedefStart);
    const commentEnd = source.indexOf("*/", typedefStart);
    if (commentStart === -1 || commentEnd === -1) continue;

    const commentBlock = source.slice(commentStart, commentEnd + 2);
    const commentBlockStart = commentStart;

    /** @type {ContextField[]} */
    const fields = [];
    let propMatch;
    propRegex.lastIndex = 0;
    while ((propMatch = propRegex.exec(commentBlock)) !== null) {
      const propType = propMatch[1];
      let propName = propMatch[2];
      const propDesc = propMatch[3] || undefined;

      // Handle optional props: [propName]
      const optional = propName.startsWith("[");
      propName = propName.replace(/^\[|\]$/g, "");

      const propOffset = commentBlockStart + propMatch.index;
      const lineInfo = getLineAndColumn(source, propOffset);

      fields.push({
        name: propName,
        type: optional ? `${propType} | undefined` : propType,
        description: propDesc,
        range: {
          start: lineInfo,
          end: { line: lineInfo.line, column: lineInfo.column + propMatch[0].length }
        }
      });
    }

    typedefs.set(typedefName, fields);
  }

  return typedefs;
}

/**
 * Resolve context data fields for a class from its JSDoc @extends tag.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {Map<string, ContextField[]>} typedefs
 * @param {string} source
 * @param {ts.SourceFile} sourceFile
 * @returns {ContextField[]}
 */
/**
 * Match `@extends BlazeComponent<...>` handling nested angle brackets.
 * @param {string} text
 * @returns {RegExpMatchArray|null} Match with capture group 1 = type parameter content
 */
/**
 * True if `text[i]` is `>` that closes a type argument list (not part of `=>` or `>=`).
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isTypeArgCloseAngle(text, i) {
  if (text[i] !== ">") return false;
  // `=>` arrow
  if (i > 0 && text[i - 1] === "=") return false;
  // `>=` comparison (unlikely in types, but safe)
  if (i + 1 < text.length && text[i + 1] === "=") return false;
  return true;
}

function matchBalancedExtends(text) {
  const marker = "@extends";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = text.slice(idx);
  const openMatch = after.match(/@extends\s+\{?\s*BlazeComponent</);
  if (!openMatch) return null;

  const contentStart = idx + openMatch[0].length;
  let depth = 1;
  let i = contentStart;
  while (i < text.length && depth > 0) {
    if (text[i] === "<") depth++;
    else if (isTypeArgCloseAngle(text, i)) depth--;
    i++;
  }

  if (depth !== 0) return null;

  const content = text.slice(contentStart, i - 1);
  const result = [text.slice(idx, i), content];
  result.index = idx;
  result.input = text;
  return result;
}

/**
 * Leading trivia / JSDoc immediately above a class (full comment, not a fixed char window).
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {string} source
 * @param {ts.SourceFile} sourceFile
 * @returns {string}
 */
function getLeadingTextBeforeClass(cls, source, sourceFile) {
  const fullStart = cls.node.getFullStart();
  const start = cls.node.getStart(sourceFile);
  const leading = source.slice(fullStart, start);
  if (leading.includes("@extends")) return leading;

  // Fallback: walk back to the nearest /** block (handles oversized comments)
  const searchFrom = Math.max(0, start - 20000);
  const slice = source.slice(searchFrom, start);
  const commentStart = slice.lastIndexOf("/**");
  if (commentStart !== -1) return slice.slice(commentStart);
  return slice;
}

/**
 * Split BlazeComponent<A, B> type-arg list on the top-level comma.
 * @param {string} typeArgsContent
 * @returns {string[]}
 */
function splitTopLevelTypeArgs(typeArgsContent) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < typeArgsContent.length; i++) {
    const ch = typeArgsContent[i];
    if (ch === "<" || ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (isTypeArgCloseAngle(typeArgsContent, i)) depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolveContextData(cls, typedefs, source, sourceFile) {
  const textBefore = getLeadingTextBeforeClass(cls, source, sourceFile);
  const extendsMatch = matchBalancedExtends(textBefore);

  if (extendsMatch) {
    // BlazeComponent<ContextData, Settings?> — only the first type arg is ContextData
    const typeArgs = splitTopLevelTypeArgs(extendsMatch[1].trim());
    const typeParam = (typeArgs[0] || "").trim();
    if (!typeParam) return [];

    // Check if it's a known typedef name
    const fromTypedef = typedefs.get(typeParam);
    if (fromTypedef) return fromTypedef;

    // Try to parse inline object type: { prop: Type, ... }
    const inlineFields = parseInlineObjectType(typeParam);
    if (inlineFields) return inlineFields;

    // Primitive or complex non-object type
    return [{
      name: "data",
      type: typeParam,
      description: "Context data",
      range: {
        start: { line: 0, column: 0 },
        end: { line: 0, column: 0 }
      }
    }];
  }

  return [];
}

/**
 * Parse an inline object type like `{ foo: string, bar: number[] }` into ContextFields.
 * Handles JSDoc comment artifacts (leading `*`), multiline formatting, and hybrid
 * `prop?: Type - description` prose (commas in descriptions must not split fields).
 * @param {string} raw
 * @returns {ContextField[]|null}
 */
function parseInlineObjectType(raw) {
  // Strip outer braces
  const stripped = raw.replace(/^\s*\{/, "").replace(/\}\s*$/, "");
  if (stripped === raw) return null;

  // Clean JSDoc comment artifacts: leading ` * ` on each line
  const cleaned = stripped
    .split("\n")
    .map(l => l.replace(/^\s*\*\s?/, "").trim())
    .join(" ")
    .trim();

  if (!cleaned) return null;

  // Find field starts `name:` / `name?:` at depth 0 — more robust than comma-splitting
  // when descriptions contain commas.
  const fieldStartRe = /([A-Za-z_$][A-Za-z0-9_$]*)(\??)\s*:/g;
  /** @type {{ name: string, optional: boolean, start: number, valueStart: number }[]} */
  const starts = [];
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "<" || ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === "}" || ch === ")" || ch === "]") {
      if (!(ch === ">" && i > 0 && cleaned[i - 1] === "=")) depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      fieldStartRe.lastIndex = i;
      const m = fieldStartRe.exec(cleaned);
      if (m && m.index === i) {
        starts.push({
          name: m[1],
          optional: m[2] === "?",
          start: m.index,
          valueStart: m.index + m[0].length
        });
        i = m.index + m[0].length - 1;
      }
    }
  }

  if (starts.length === 0) {
    // Fallback: comma-split for simple `{ a: string, b: number }`
    /** @type {ContextField[]} */
    const fields = [];
    depth = 0;
    let current = "";
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === "<" || ch === "{" || ch === "(") depth++;
      else if (ch === ">" || ch === "}" || ch === ")") {
        if (!(ch === ">" && i > 0 && cleaned[i - 1] === "=")) depth--;
      } else if (ch === "," && depth === 0) {
        const field = parseFieldEntry(current.trim());
        if (field) fields.push(field);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) {
      const field = parseFieldEntry(current.trim());
      if (field) fields.push(field);
    }
    return fields.length > 0 ? fields : null;
  }

  /** @type {ContextField[]} */
  const fields = [];
  for (let s = 0; s < starts.length; s++) {
    const cur = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1].start : cleaned.length;
    let value = cleaned.slice(cur.valueStart, end).trim();
    // Drop trailing comma between fields
    value = value.replace(/,\s*$/, "");
    const entry = parseFieldEntry(
      `${cur.name}${cur.optional ? "?" : ""}: ${value}`
    );
    if (entry) fields.push(entry);
  }

  return fields.length > 0 ? fields : null;
}

/**
 * Parse a single `name: Type` or `name?: Type` entry.
 * Strips trailing JSDoc-style ` - description` prose (not valid in TS types).
 * @param {string} entry
 * @returns {ContextField|null}
 */
function parseFieldEntry(entry) {
  const match = entry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(\??):\s*(.+)$/s);
  if (!match) return null;
  const name = match[1];
  const optional = match[2] === "?";
  let typeAndMaybeDesc = match[3].trim();

  // Split type from ` - description` at depth 0 (hybrid JSDoc-in-object-type style)
  let depth = 0;
  let typeEnd = typeAndMaybeDesc.length;
  let description;
  for (let i = 0; i < typeAndMaybeDesc.length; i++) {
    const ch = typeAndMaybeDesc[i];
    if (ch === "<" || ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0 && typeAndMaybeDesc.slice(i, i + 3) === " - ") {
      description = typeAndMaybeDesc.slice(i + 3).trim() || undefined;
      typeEnd = i;
      break;
    }
  }
  let type = typeAndMaybeDesc.slice(0, typeEnd).trim();
  // Collapse leftover whitespace/newlines inside the type
  type = type.replace(/\s+/g, " ");
  if (optional) type = `${type} | undefined`;

  return {
    name,
    type,
    description,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
  };
}

/**
 * Extract JSDoc documentation and return types for helper methods.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @param {ts.SourceFile} sourceFile
 * @param {string} source
 * @returns {Map<string, { returnType?: string, documentation?: string, params?: HelperParam[] }>}
 */
function extractHelperDocs(cls, sourceFile, source) {
  /** @type {Map<string, { returnType?: string, documentation?: string, params?: HelperParam[] }>} */
  const docs = new Map();

  for (const member of cls.node.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      let returnType;
      let documentation;
      /** @type {HelperParam[]} */
      const params = [];

      // 1. Try TS API JSDoc tags
      const jsDocNodes = ts.getJSDocTags(member);
      for (const tag of jsDocNodes) {
        if (tag.tagName.text === "returns" || tag.tagName.text === "return") {
          const typeExpr = /** @type {any} */ (tag).typeExpression;
          if (typeExpr && typeExpr.type) {
            returnType = source.slice(typeExpr.type.pos, typeExpr.type.end).trim();
          }
          if (!returnType && tag.comment) {
            returnType = typeof tag.comment === "string" ? tag.comment : tag.comment.map(c => c.text).join("");
          }
        }
        if (tag.tagName.text === "param") {
          const paramTag = /** @type {any} */ (tag);
          const paramName = paramTag.name ? paramTag.name.getText(sourceFile) : undefined;
          let paramType;
          if (paramTag.typeExpression && paramTag.typeExpression.type) {
            paramType = source.slice(paramTag.typeExpression.type.pos, paramTag.typeExpression.type.end).trim();
          }
          const paramDesc = tag.comment
            ? (typeof tag.comment === "string" ? tag.comment : tag.comment.map(c => c.text).join(""))
            : undefined;
          if (paramName) {
            params.push({ name: paramName, type: paramType, description: paramDesc });
          }
        }
      }

      // 2. Fallback: regex on the raw JSDoc comment
      const fullStart = member.getFullStart();
      const start = member.getStart(sourceFile);
      const leadingText = source.slice(fullStart, start);
      const jsdocMatch = leadingText.match(/\/\*\*([\s\S]*?)\*\//);
      if (jsdocMatch) {
        if (!returnType) {
          const returnsMatch = jsdocMatch[1].match(/@returns?\s+\{([^}]+)\}/);
          if (returnsMatch) {
            returnType = returnsMatch[1];
          }
        }
        // Regex fallback for @param if TS API didn't find them
        if (params.length === 0) {
          const paramRegex = /@param\s+(?:\{([^}]+)\}\s+)?(\w+)(?:\s+-\s*(.*))?/g;
          let pm;
          while ((pm = paramRegex.exec(jsdocMatch[1])) !== null) {
            params.push({ name: pm[2], type: pm[1] || undefined, description: pm[3] || undefined });
          }
        }
        const cleaned = jsdocMatch[1]
          .split("\n")
          .map(l => l.replace(/^\s*\*\s?/, "").trim())
          .filter(l => l && !l.startsWith("@"))
          .join(" ");
        if (cleaned) documentation = cleaned;
      }

      // 3. Fallback: extract param names from the method signature itself
      if (params.length === 0 && member.parameters.length > 0) {
        for (const p of member.parameters) {
          if (ts.isIdentifier(p.name)) {
            params.push({ name: p.name.text, type: undefined, description: undefined });
          }
        }
      }

      // 4. Fallback: infer return type from the method body
      if (!returnType && member.body) {
        returnType = inferReturnType(member, sourceFile, source);
      }

      docs.set(member.name.text, { returnType, documentation, params: params.length > 0 ? params : undefined });
    }
  }

  return docs;
}

/**
 * Infer a return type from method bodies (used when JSDoc/@returns and the checker yield any).
 * Collects all return expressions (including nested in if/blocks) and unifies literal types.
 * @param {ts.MethodDeclaration|ts.ArrowFunction|ts.FunctionExpression} method
 * @param {ts.SourceFile} sourceFile
 * @param {string} [source]
 * @returns {string|undefined}
 */
function inferReturnType(method, sourceFile, source) {
  const body = method.body;
  if (!body) return undefined;

  /** @type {ts.Expression[]} */
  const returns = [];
  collectReturnExpressions(body, returns);
  if (returns.length === 0) return undefined;

  /** @type {Set<string>} */
  const types = new Set();
  for (const expr of returns) {
    const t = inferExprType(expr, source);
    if (t) types.add(t);
  }

  if (types.size === 0) return undefined;
  if (types.size === 1) return [...types][0];
  // Drop null/undefined noise when other concretes exist
  types.delete("null");
  types.delete("undefined");
  if (types.size === 1) return [...types][0];
  if (types.size === 0) return undefined;
  return [...types].sort().join(" | ");
}

/**
 * @param {ts.Node} node
 * @param {ts.Expression[]} out
 */
function collectReturnExpressions(node, out) {
  if (ts.isReturnStatement(node) && node.expression) {
    out.push(node.expression);
    return;
  }
  // Do not descend into nested functions / methods
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return;
  }
  ts.forEachChild(node, child => collectReturnExpressions(child, out));
}

/**
 * Infer type of a simple expression node.
 * @param {ts.Expression} expr
 * @param {string} [source]
 * @returns {string|undefined}
 */
function inferExprType(expr, source) {
  if (ts.isParenthesizedExpression(expr)) return inferExprType(expr.expression, source);
  if (ts.isAsExpression(expr)) return inferExprType(expr.expression, source);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
  if (ts.isTemplateExpression(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(expr)) return "Array";
  if (ts.isObjectLiteralExpression(expr)) return "Object";

  // !x / !!x → boolean
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return "boolean";
  }

  // a || b || "literal"  /  a ?? b
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const right = inferExprType(expr.right, source);
      const left = inferExprType(expr.left, source);
      if (left && right && left === right) return left;
      // Prefer the rightmost concrete type (common fallback literal pattern)
      if (right) return right;
      if (left) return left;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return inferExprType(expr.right, source) || inferExprType(expr.left, source);
    }
  }

  if (ts.isConditionalExpression(expr)) {
    const whenTrue = inferExprType(expr.whenTrue, source);
    const whenFalse = inferExprType(expr.whenFalse, source);
    if (whenTrue && whenFalse && whenTrue === whenFalse) return whenTrue;
    if (whenTrue && whenFalse) return `${whenTrue} | ${whenFalse}`;
    return whenTrue || whenFalse;
  }

  if (ts.isCallExpression(expr) && source) {
    const callText = source.slice(expr.expression.pos, expr.expression.end).trim();
    if (callText === "this.reactiveData" || callText === "this.nonReactiveData") return "ContextData";
  }

  return undefined;
}

/**
 * Find a method declaration by name in a class.
 * @param {ts.ClassDeclaration} classNode
 * @param {string} name
 * @returns {ts.MethodDeclaration|null}
 */
function findMethodByName(classNode, name) {
  for (const member of classNode.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.name.text === name) {
      return member;
    }
  }
  return null;
}

/**
 * Get the parent class name from a class declaration.
 * @param {{ name: string, node: ts.ClassDeclaration }} cls
 * @returns {string|null}
 */
function getParentClassName(cls) {
  const heritage = cls.node.heritageClauses;
  if (!heritage) return null;

  for (const clause of heritage) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      const type = clause.types[0];
      if (type && ts.isIdentifier(type.expression)) {
        return type.expression.text;
      }
    }
  }
  return null;
}

/**
 * Check if a class member has the `static` modifier.
 * @param {ts.ClassElement} member
 * @returns {boolean}
 */
function hasStaticModifier(member) {
  if (!member.modifiers) return false;
  return member.modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * Convert a TS node to a SourceRange.
 * @param {ts.Node} node
 * @param {ts.SourceFile} sourceFile
 * @returns {SourceRange}
 */
function nodeRange(node, sourceFile) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character }
  };
}

/**
 * Get line and column for a given offset in source text.
 * @param {string} source
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
function getLineAndColumn(source, offset) {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline - 1 };
}

/**
 * Find Blaze.registerHelper() calls in a source file.
 * @param {string} source
 * @param {string} filePath
 * @returns {GlobalHelperInfo[]}
 */
function findGlobalHelpers(source, filePath) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {GlobalHelperInfo[]} */
  const helpers = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerHelper" &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Blaze" || node.expression.expression.text === "Template")
    ) {
      const args = node.arguments;
      if (args.length >= 2 && ts.isStringLiteral(args[0])) {
        const name = args[0].text;
        const start = getLineAndColumn(source, node.getStart(sourceFile));
        const end = getLineAndColumn(source, node.getEnd());
        const range = { start, end };

        /** @type {string|undefined} */
        let returnType;
        /** @type {HelperParam[]} */
        const params = [];

        const fn = args[1];
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
          for (const p of fn.parameters) {
            const pName = p.name.getText(sourceFile);
            const jsDocType = ts.getJSDocType(p);
            const pType = jsDocType ? jsDocType.getText(sourceFile) : undefined;
            params.push({ name: pName, type: pType });
          }

          const jsDocReturn = getJSDocReturnType(fn, sourceFile);
          if (jsDocReturn) {
            returnType = jsDocReturn;
          } else if (fn.body) {
            if (ts.isBlock(fn.body)) {
              returnType = inferReturnType(fn, sourceFile, source);
            } else {
              returnType = inferSimpleReturnType(fn.body, sourceFile);
            }
          }
        }

        let documentation;
        const jsDocComments = ts.getJSDocCommentsAndTags(node);
        for (const jd of jsDocComments) {
          if (ts.isJSDoc(jd) && jd.comment) {
            documentation = typeof jd.comment === "string" ? jd.comment : jd.comment.map(c => c.text || "").join("");
            break;
          }
        }

        helpers.push({ name, filePath, range, returnType, documentation, params: params.length > 0 ? params : undefined });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return helpers;
}

/**
 * Get @returns type from JSDoc on a node.
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {string|undefined}
 */
function getJSDocReturnType(node, sourceFile) {
  const jsDocs = ts.getJSDocTags(node);
  for (const tag of jsDocs) {
    if (tag.tagName.text === "returns" || tag.tagName.text === "return") {
      if (tag.typeExpression) {
        return tag.typeExpression.type.getText(sourceFile);
      }
    }
  }
  return undefined;
}

/**
 * Infer a simple return type from an expression body.
 * @param {import("typescript").Expression} expr
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {string|undefined}
 */
function inferSimpleReturnType(expr, sourceFile) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
  if (ts.isTemplateExpression(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isArrayLiteralExpression(expr)) return "Array";
  if (ts.isObjectLiteralExpression(expr)) return "Object";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const COMPARISON_OPS = [
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
    ];
    const LOGICAL_OPS = [
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
    ];
    if (COMPARISON_OPS.includes(op)) return "boolean";
    if (LOGICAL_OPS.includes(op)) {
      const left = inferSimpleReturnType(expr.left, sourceFile);
      const right = inferSimpleReturnType(expr.right, sourceFile);
      if (left && left === right) return left;
    }
    const ARITHMETIC_OPS = [
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
    ];
    if (ARITHMETIC_OPS.includes(op)) {
      const left = inferSimpleReturnType(expr.left, sourceFile);
      const right = inferSimpleReturnType(expr.right, sourceFile);
      if (op === ts.SyntaxKind.PlusToken && (left === "string" || right === "string")) return "string";
      return "number";
    }
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return "boolean";
  }

  if (ts.isConditionalExpression(expr)) {
    const t = inferSimpleReturnType(expr.whenTrue, sourceFile);
    const f = inferSimpleReturnType(expr.whenFalse, sourceFile);
    if (t && t === f) return t;
    if (t) return t;
  }

  if (ts.isParenthesizedExpression(expr)) {
    return inferSimpleReturnType(expr.expression, sourceFile);
  }

  return undefined;
}

module.exports = {
  parseComponent,
  findGlobalHelpers,
  findClasses,
  findExplicitRegistrations,
  findHTMLImports,
  findTypedefsFromJSDoc,
  extractHelperMap,
  extractDecoratedHelpers,
  extractEventMap,
  extractDecoratedEvents
};
