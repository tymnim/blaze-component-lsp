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
    else if (text[i] === ">") depth--;
    i++;
  }

  if (depth !== 0) return null;

  const content = text.slice(contentStart, i - 1);
  const result = [text.slice(idx, i), content];
  result.index = idx;
  result.input = text;
  return result;
}

function resolveContextData(cls, typedefs, source, sourceFile) {
  const classStart = cls.node.getStart(sourceFile);

  const textBefore = source.slice(Math.max(0, classStart - 500), classStart);
  const extendsMatch = matchBalancedExtends(textBefore);

  if (extendsMatch) {
    const typeParam = extendsMatch[1].trim();

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
 * Handles JSDoc comment artifacts (leading `*`) and multiline formatting.
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

  /** @type {ContextField[]} */
  const fields = [];
  // Split on commas that are not inside angle brackets or nested braces
  let depth = 0;
  let current = "";
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    else if (ch === ">" || ch === "}" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
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

/**
 * Parse a single `name: Type` or `name?: Type` entry.
 * @param {string} entry
 * @returns {ContextField|null}
 */
function parseFieldEntry(entry) {
  const match = entry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(\??):\s*(.+)$/);
  if (!match) return null;
  const name = match[1];
  const optional = match[2] === "?";
  const type = optional ? `${match[3]} | undefined` : match[3];
  return {
    name,
    type,
    description: undefined,
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
 * Infer a return type from simple method bodies.
 * @param {ts.MethodDeclaration} method
 * @param {ts.SourceFile} sourceFile
 * @param {string} source
 * @returns {string|undefined}
 */
function inferReturnType(method, sourceFile, source) {
  const body = method.body;
  if (!body || !body.statements.length) return undefined;

  for (const stmt of body.statements) {
    if (!ts.isReturnStatement(stmt) || !stmt.expression) continue;
    const expr = stmt.expression;

    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
    if (ts.isNumericLiteral(expr)) return "number";
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
    if (ts.isArrayLiteralExpression(expr)) return "Array";
    if (ts.isObjectLiteralExpression(expr)) return "Object";
    if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";

    // this.get("key") ? "a" : "b" → string
    if (ts.isConditionalExpression(expr)) {
      const whenTrue = expr.whenTrue;
      const whenFalse = expr.whenFalse;
      if (ts.isStringLiteral(whenTrue) && ts.isStringLiteral(whenFalse)) return "string";
      if (ts.isNumericLiteral(whenTrue) && ts.isNumericLiteral(whenFalse)) return "number";
    }

    // this.get("key") → look at the key name for hints
    if (ts.isCallExpression(expr)) {
      const callText = source.slice(expr.expression.pos, expr.expression.end).trim();
      if (callText === "this.get") return undefined; // generic state access
      if (callText === "this.reactiveData" || callText === "this.nonReactiveData") return "ContextData";
      if (callText.endsWith(".get")) return undefined;
    }

    // this.checked.get() ? "checked" : "unchecked" → string (ternary with call)
    if (ts.isConditionalExpression(expr)) {
      const inferredTrue = inferExprType(expr.whenTrue);
      const inferredFalse = inferExprType(expr.whenFalse);
      if (inferredTrue && inferredTrue === inferredFalse) return inferredTrue;
      if (inferredTrue) return inferredTrue;
    }
  }

  return undefined;
}

/**
 * Infer type of a simple expression node.
 * @param {ts.Expression} expr
 * @returns {string|undefined}
 */
function inferExprType(expr) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isArrayLiteralExpression(expr)) return "Array";
  if (ts.isObjectLiteralExpression(expr)) return "Object";
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

module.exports = {
  parseComponent,
  findClasses,
  findExplicitRegistrations,
  findHTMLImports,
  findTypedefsFromJSDoc,
  extractHelperMap,
  extractDecoratedHelpers,
  extractEventMap,
  extractDecoratedEvents
};
