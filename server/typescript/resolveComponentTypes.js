// @ts-check
const ts = require("typescript");

/**
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 * @typedef {import("../parsers/componentParser").HelperInfo} HelperInfo
 * @typedef {import("../parsers/componentParser").GlobalHelperInfo} GlobalHelperInfo
 * @typedef {import("../parsers/componentParser").ContextField} ContextField
 * @typedef {import("./typeService").TypeService} TypeService
 */

/**
 * Enrich components with ContextData and helper types from the TypeScript checker.
 * Keeps existing AST/JSDoc-extracted types as fallback when the checker cannot resolve.
 * @param {ComponentInfo[]} components
 * @param {TypeService} typeService
 * @param {string} filePath
 */
function resolveComponentTypes(components, typeService, filePath) {
  if (!components.length) return;

  const checker = typeService.getChecker();
  const sourceFile = typeService.getSourceFile(filePath);
  if (!checker || !sourceFile) return;

  for (const comp of components) {
    const classNode = findClassDeclaration(sourceFile, comp.className);
    if (!classNode) continue;

    const classType = checker.getTypeAtLocation(classNode);
    const contextFields = resolveContextDataFromClass(checker, typeService, classType, classNode);
    // Prefer checker types when they look complete. TS's JSDoc @extends parser often
    // truncates hybrid inline object types that include ` - description` prose — in
    // that case keep the richer string/JSDoc field list from parseComponent.
    if (contextFields && contextFields.length > 0) {
      const existing = comp.contextDataFields || [];
      if (existing.length === 0 || contextFields.length >= existing.length) {
        comp.contextDataFields = contextFields;
      } else {
        // Merge: keep all string-parsed names; upgrade types from checker when present
        const byName = new Map(contextFields.map(f => [f.name, f]));
        comp.contextDataFields = existing.map(f => {
          const fromChecker = byName.get(f.name);
          return fromChecker ? { ...f, type: fromChecker.type, range: fromChecker.range || f.range } : f;
        });
      }
    }

    for (const helper of comp.helpers) {
      enrichHelperFromClass(checker, typeService, classType, classNode, helper);
    }
  }
}

/**
 * Enrich global helpers registered via Blaze/Template.registerHelper.
 * @param {GlobalHelperInfo[]} helpers
 * @param {TypeService} typeService
 * @param {string} filePath
 */
function resolveGlobalHelperTypes(helpers, typeService, filePath) {
  if (!helpers.length) return;

  const checker = typeService.getChecker();
  const sourceFile = typeService.getSourceFile(filePath);
  if (!checker || !sourceFile) return;

  const registrations = findRegisterHelperCalls(sourceFile);

  for (const helper of helpers) {
    const call = registrations.find(r => r.name === helper.name);
    if (!call || !call.fnNode) continue;

    const fnType = checker.getTypeAtLocation(call.fnNode);
    applySignatureToHelper(checker, typeService, fnType, call.fnNode, helper);

    // If contextual typing left us with any, fall back to JSDoc on the function node
    if (!helper.returnType || helper.returnType === "any") {
      const jsDocReturn = getJsDocReturnTypeString(call.fnNode, checker, typeService);
      if (jsDocReturn) helper.returnType = jsDocReturn;
    }
    if (!helper.params || helper.params.every(p => !p.type)) {
      const jsDocParams = getJsDocParams(call.fnNode);
      if (jsDocParams.length) helper.params = jsDocParams;
    }
  }
}

/**
 * @param {ts.Node} node
 * @param {ts.TypeChecker} checker
 * @param {TypeService} typeService
 * @returns {string|undefined}
 */
function getJsDocReturnTypeString(node, checker, typeService) {
  const tags = ts.getJSDocTags(node);
  for (const tag of tags) {
    if (tag.tagName.text === "returns" || tag.tagName.text === "return") {
      const typeExpr = /** @type {any} */ (tag).typeExpression;
      if (typeExpr && typeExpr.type) {
        try {
          return typeService.getTypeString(checker.getTypeFromTypeNode(typeExpr.type), node);
        } catch {
          return typeExpr.type.getText();
        }
      }
    }
  }
  return undefined;
}

/**
 * @param {ts.Node} node
 * @returns {import("../parsers/componentParser").HelperParam[]}
 */
function getJsDocParams(node) {
  /** @type {import("../parsers/componentParser").HelperParam[]} */
  const params = [];
  const tags = ts.getJSDocTags(node);
  for (const tag of tags) {
    if (tag.tagName.text !== "param") continue;
    const paramTag = /** @type {any} */ (tag);
    const name = paramTag.name ? paramTag.name.getText() : undefined;
    let type;
    if (paramTag.typeExpression && paramTag.typeExpression.type) {
      type = paramTag.typeExpression.type.getText();
    }
    if (name) params.push({ name, type });
  }
  return params;
}

/**
 * @param {ts.SourceFile} sourceFile
 * @param {string} className
 * @returns {ts.ClassDeclaration|undefined}
 */
function findClassDeclaration(sourceFile, className) {
  /** @type {ts.ClassDeclaration|undefined} */
  let found;
  function visit(node) {
    if (found) return;
    if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * Resolve ContextData by reading the return type of `nonReactiveData()` on the class,
 * which is typed as ContextData on BlazeComponent.
 * @param {ts.TypeChecker} checker
 * @param {TypeService} typeService
 * @param {ts.Type} classType
 * @param {ts.ClassDeclaration} classNode
 * @returns {ContextField[]|null}
 */
function resolveContextDataFromClass(checker, typeService, classType, classNode) {
  const contextType = getContextDataType(checker, classType, classNode);
  if (!contextType) return null;

  // Primitive / non-object context (e.g. BlazeComponent<boolean>)
  if (!isObjectLikeContext(checker, contextType)) {
    const typeStr = typeService.getTypeString(contextType, classNode);
    if (!typeStr || typeStr === "any" || typeStr === "{}") return null;
    return [{
      name: "data",
      type: typeStr,
      description: "Context data",
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
    }];
  }

  const props = checker.getPropertiesOfType(contextType);
  if (!props.length) return null;

  /** @type {ContextField[]} */
  const fields = [];
  for (const prop of props) {
    if (prop.flags & ts.SymbolFlags.Method) continue;
    // Skip prototype / internal symbols
    if (prop.escapedName === "__proto__") continue;

    const name = prop.getName();
    if (name.startsWith("__")) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, classNode);
    let typeStr = typeService.getTypeString(propType, classNode);

    const optional = !!(prop.flags & ts.SymbolFlags.Optional) ||
      isOptionalUnion(checker, propType);
    if (optional && !typeStr.includes("undefined") && !/\|\s*undefined/.test(typeStr)) {
      // Represent optional the same way the JSDoc path did
      if (!(propType.flags & ts.TypeFlags.Undefined)) {
        // leave type as checker printed it; often already includes | undefined
      }
    }

    const decls = prop.getDeclarations();
    let range = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
    if (decls && decls.length > 0) {
      const decl = decls[0];
      const sf = decl.getSourceFile();
      const start = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(decl.getEnd());
      range = {
        start: { line: start.line, column: start.character },
        end: { line: end.line, column: end.character }
      };
    }

    const docs = ts.displayPartsToString(prop.getDocumentationComment(checker));

    fields.push({
      name,
      type: typeStr,
      description: docs || undefined,
      range
    });
  }

  return fields.length > 0 ? fields : null;
}

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} classType
 * @param {ts.Node} classNode
 * @returns {ts.Type|undefined}
 */
function getContextDataType(checker, classType, classNode) {
  // Prefer nonReactiveData(): ContextData — works for both typed heritage and JSDoc @extends
  const nr = getPropertySymbol(classType, "nonReactiveData");
  if (nr) {
    const propType = checker.getTypeOfSymbolAtLocation(nr, classNode);
    const sigs = propType.getCallSignatures();
    if (sigs.length > 0) {
      const ret = sigs[0].getReturnType();
      if (!(ret.flags & ts.TypeFlags.Any)) return ret;
    }
  }

  // Fallback: look at BlazeComponent type arguments on heritage / apparent type
  const target = classType.getSymbol();
  if (target) {
    const decls = target.getDeclarations() || [];
    for (const decl of decls) {
      if (!ts.isClassDeclaration(decl) || !decl.heritageClauses) continue;
      for (const clause of decl.heritageClauses) {
        for (const typeNode of clause.types) {
          if (typeNode.typeArguments && typeNode.typeArguments.length > 0) {
            const exprText = typeNode.expression.getText(decl.getSourceFile());
            if (exprText.includes("BlazeComponent")) {
              return checker.getTypeFromTypeNode(typeNode.typeArguments[0]);
            }
          }
        }
      }
    }
  }

  // JSDoc @extends BlazeComponent<T>
  const jsDocs = ts.getJSDocTags(classNode);
  for (const tag of jsDocs) {
    if (tag.tagName.text !== "extends") continue;
    const typeExpr = /** @type {any} */ (tag).typeExpression;
    if (typeExpr && typeExpr.type && ts.isTypeReferenceNode(typeExpr.type)) {
      if (typeExpr.type.typeArguments && typeExpr.type.typeArguments.length > 0) {
        return checker.getTypeFromTypeNode(typeExpr.type.typeArguments[0]);
      }
    }
  }

  return undefined;
}

/**
 * @param {ts.Type} type
 * @param {string} name
 * @returns {ts.Symbol|undefined}
 */
function getPropertySymbol(type, name) {
  const props = type.getProperties();
  return props.find(p => p.getName() === name || p.escapedName === name);
}

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} type
 * @returns {boolean}
 */
function isObjectLikeContext(checker, type) {
  if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean |
      ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral |
      ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never |
      ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.BigInt |
      ts.TypeFlags.BigIntLiteral)) {
    return false;
  }
  // Union of primitives → treat as single data field
  if (type.isUnion()) {
    const allPrimitive = type.types.every(t =>
      !!(t.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean |
        ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void))
    );
    if (allPrimitive) return false;
  }

  const props = checker.getPropertiesOfType(type);
  return props.length > 0;
}

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} type
 * @returns {boolean}
 */
function isOptionalUnion(checker, type) {
  if (!type.isUnion()) return false;
  return type.types.some(t => !!(t.flags & ts.TypeFlags.Undefined));
}

/**
 * @param {ts.TypeChecker} checker
 * @param {TypeService} typeService
 * @param {ts.Type} classType
 * @param {ts.ClassDeclaration} classNode
 * @param {HelperInfo} helper
 */
function enrichHelperFromClass(checker, typeService, classType, classNode, helper) {
  const methodSym = getPropertySymbol(classType, helper.methodName);
  if (!methodSym) return;

  const methodType = checker.getTypeOfSymbolAtLocation(methodSym, classNode);
  applySignatureToHelper(checker, typeService, methodType, classNode, helper);

  // Prefer JSDoc documentation from the symbol when present
  const docs = ts.displayPartsToString(methodSym.getDocumentationComment(checker));
  if (docs && !helper.documentation) {
    helper.documentation = docs;
  }

  // When the checker yields `any` (common without @returns in checkJs), keep/upgrade
  // via AST inference from the method body (|| chains, ternaries, literals, etc.).
  if (!helper.returnType || helper.returnType === "any") {
    const decls = methodSym.getDeclarations() || [];
    for (const d of decls) {
      if (ts.isMethodDeclaration(d) && d.body) {
        const inferred = inferReturnTypeFromDeclaration(d);
        if (inferred) {
          helper.returnType = inferred;
          break;
        }
      }
    }
  }
}

/**
 * Lightweight return inference from a method declaration (mirrors componentParser heuristics).
 * @param {ts.MethodDeclaration} method
 * @returns {string|undefined}
 */
function inferReturnTypeFromDeclaration(method) {
  /** @type {ts.Expression[]} */
  const returns = [];
  /** @param {ts.Node} node */
  function walk(node) {
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      (ts.isMethodDeclaration(node) && node !== method) ||
      ts.isConstructorDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, walk);
  }
  if (method.body) walk(method.body);

  /** @type {Set<string>} */
  const types = new Set();
  for (const expr of returns) {
    const t = inferExprTypeLocal(expr);
    if (t) types.add(t);
  }
  if (types.size === 0) return undefined;
  if (types.size === 1) return [...types][0];
  types.delete("null");
  types.delete("undefined");
  if (types.size === 1) return [...types][0];
  if (types.size === 0) return undefined;
  return [...types].sort().join(" | ");
}

/**
 * @param {ts.Expression} expr
 * @returns {string|undefined}
 */
function inferExprTypeLocal(expr) {
  if (ts.isParenthesizedExpression(expr)) return inferExprTypeLocal(expr.expression);
  if (ts.isAsExpression(expr)) return inferExprTypeLocal(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
  if (ts.isTemplateExpression(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(expr)) return "Array";
  if (ts.isObjectLiteralExpression(expr)) return "Object";
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return "boolean";
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const right = inferExprTypeLocal(expr.right);
      const left = inferExprTypeLocal(expr.left);
      if (left && right && left === right) return left;
      if (right) return right;
      if (left) return left;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return inferExprTypeLocal(expr.right) || inferExprTypeLocal(expr.left);
    }
  }
  if (ts.isConditionalExpression(expr)) {
    const a = inferExprTypeLocal(expr.whenTrue);
    const b = inferExprTypeLocal(expr.whenFalse);
    if (a && b && a === b) return a;
    if (a && b) return `${a} | ${b}`;
    return a || b;
  }
  return undefined;
}

/**
 * Apply call-signature return/params onto a helper info object.
 * Only overwrites when the checker produces a useful (non-any) type.
 * @param {ts.TypeChecker} checker
 * @param {TypeService} typeService
 * @param {ts.Type} fnType
 * @param {ts.Node} node
 * @param {HelperInfo|GlobalHelperInfo} helper
 */
function applySignatureToHelper(checker, typeService, fnType, node, helper) {
  const sigs = fnType.getCallSignatures();
  if (!sigs.length) return;
  const sig = sigs[0];

  const returnType = sig.getReturnType();
  const returnStr = typeService.getTypeString(returnType, node);
  if (returnStr && returnStr !== "any" && returnStr !== "error") {
    helper.returnType = returnStr;
  } else if (!helper.returnType && returnStr === "void") {
    helper.returnType = "void";
  }

  const params = sig.getParameters();
  if (params.length > 0) {
    helper.params = params.map(p => {
      const pType = checker.getTypeOfSymbolAtLocation(p, node);
      const typeStr = typeService.getTypeString(pType, node);
      const pDocs = ts.displayPartsToString(p.getDocumentationComment(checker));
      return {
        name: p.getName(),
        type: typeStr !== "any" ? typeStr : undefined,
        description: pDocs || undefined
      };
    });
  }
}

/**
 * @param {ts.SourceFile} sourceFile
 * @returns {{ name: string, fnNode: ts.Expression|undefined }[]}
 */
function findRegisterHelperCalls(sourceFile) {
  /** @type {{ name: string, fnNode: ts.Expression|undefined }[]} */
  const results = [];

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
        results.push({ name: args[0].text, fnNode: args[1] });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

module.exports = {
  resolveComponentTypes,
  resolveGlobalHelperTypes
};
