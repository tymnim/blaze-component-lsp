// @ts-check

/**
 * @typedef {{ line: number, column: number }} Position
 * @typedef {{ start: Position, end: Position }} SourceRange
 *
 * @typedef {Object} SpacebarsParam
 * @prop {"PathExpression"|"StringLiteral"|"NumberLiteral"|"BooleanLiteral"|"SubExpression"} type
 * @prop {string} value
 * @prop {SourceRange} loc
 * @prop {SpacebarsParam[]} [params] - For SubExpression only
 * @prop {Object<string, SpacebarsParam>} [hash] - For SubExpression only
 *
 * @typedef {Object} SpacebarsNode
 * @prop {"MustacheExpression"|"RawExpression"|"PartialExpression"|"BlockExpression"|"Comment"} type
 * @prop {string} path
 * @prop {SpacebarsParam[]} params
 * @prop {Object<string, SpacebarsParam>} hash
 * @prop {SourceRange} loc
 * @prop {SpacebarsNode[]} [children]
 * @prop {SpacebarsNode[]} [inverse]
 * @prop {string[]} [blockParams]
 *
 * @typedef {Object} TemplateBlock
 * @prop {string} name
 * @prop {SourceRange} range
 * @prop {string} content - The inner HTML between <template> tags
 * @prop {number} contentStartLine - 0-based line where the content starts
 * @prop {number} contentStartColumn - 0-based column where the content starts
 * @prop {SpacebarsNode[]} expressions
 * @prop {string[]} includedTemplates
 * @prop {boolean} isBlockTemplate
 */

/**
 * Parse an HTML file and extract all template blocks with their spacebars expressions.
 * @param {string} source - Full HTML file content
 * @param {string} [filePath] - Optional file path for error reporting
 * @returns {TemplateBlock[]}
 */
function parseHTML(source, filePath) {
  const templates = extractTemplateBlocks(source);
  for (const template of templates) {
    template.expressions = parseSpacebarsExpressions(template.content, template.contentStartLine, template.contentStartColumn);
    template.includedTemplates = extractIncludedTemplates(template.expressions);
    template.isBlockTemplate = template.includedTemplates.some(
      name => name === "Template.contentBlock" || name === "Template.elseBlock"
    );
  }
  return templates;
}

/**
 * Find all <template name="...">...</template> blocks in the source.
 * @param {string} source
 * @returns {TemplateBlock[]}
 */
function extractTemplateBlocks(source) {
  /** @type {TemplateBlock[]} */
  const blocks = [];
  const templateOpenRegex = /<template\s+name=["']([^"']+)["']\s*>/gi;
  let match;

  while ((match = templateOpenRegex.exec(source)) !== null) {
    const name = match[1];
    const tagStart = match.index;
    const tagEnd = match.index + match[0].length;
    const startPos = offsetToPosition(source, tagStart);

    const closeTag = `</template>`;
    const closeIndex = source.indexOf(closeTag, tagEnd);
    if (closeIndex === -1) continue;

    const endPos = offsetToPosition(source, closeIndex + closeTag.length);
    const content = source.slice(tagEnd, closeIndex);
    const contentStartPos = offsetToPosition(source, tagEnd);

    blocks.push({
      name,
      range: { start: startPos, end: endPos },
      content,
      contentStartLine: contentStartPos.line,
      contentStartColumn: contentStartPos.column,
      expressions: [],
      includedTemplates: [],
      isBlockTemplate: false
    });
  }

  return blocks;
}

/**
 * Parse all spacebars expressions in a template body.
 * @param {string} content - Inner HTML of a template block
 * @param {number} baseLine - 0-based line offset in the file
 * @param {number} baseColumn - 0-based column offset for the first line
 * @returns {SpacebarsNode[]}
 */
function parseSpacebarsExpressions(content, baseLine, baseColumn) {
  /** @type {SpacebarsNode[]} */
  const expressions = [];
  const blockStack = /** @type {{ node: SpacebarsNode, closeTag: string }[]} */ ([]);

  let i = 0;
  while (i < content.length) {
    if (content[i] === '{' && content[i + 1] === '{') {
      const exprStart = i;

      if (content[i + 2] === '{') {
        // Raw expression {{{...}}}
        const closeIdx = content.indexOf('}}}', i + 3);
        if (closeIdx === -1) { i++; continue; }
        const inner = content.slice(i + 3, closeIdx).trim();
        const node = parseExpressionContent(inner, "RawExpression", exprStart, closeIdx + 3, content, baseLine, baseColumn);
        pushToCurrentBlock(blockStack, expressions, node);
        i = closeIdx + 3;
      } else if (content[i + 2] === '!' ) {
        // Comment
        let closeIdx;
        if (content[i + 3] === '-' && content[i + 4] === '-') {
          closeIdx = content.indexOf('--}}', i + 5);
          if (closeIdx === -1) { i++; continue; }
          const commentText = content.slice(i + 5, closeIdx).trim();
          const node = createCommentNode(commentText, exprStart, closeIdx + 4, content, baseLine, baseColumn);
          pushToCurrentBlock(blockStack, expressions, node);
          i = closeIdx + 4;
        } else {
          closeIdx = content.indexOf('}}', i + 3);
          if (closeIdx === -1) { i++; continue; }
          const commentText = content.slice(i + 3, closeIdx).trim();
          const node = createCommentNode(commentText, exprStart, closeIdx + 2, content, baseLine, baseColumn);
          pushToCurrentBlock(blockStack, expressions, node);
          i = closeIdx + 2;
        }
      } else if (content[i + 2] === '>') {
        // Partial {{> ...}}
        const closeIdx = findClosingBraces(content, i + 3);
        if (closeIdx === -1) { i++; continue; }
        const inner = content.slice(i + 3, closeIdx).trim();
        const node = parseExpressionContent(inner, "PartialExpression", exprStart, closeIdx + 2, content, baseLine, baseColumn);
        pushToCurrentBlock(blockStack, expressions, node);
        i = closeIdx + 2;
      } else if (content[i + 2] === '#') {
        // Block open {{#...}}
        const closeIdx = findClosingBraces(content, i + 3);
        if (closeIdx === -1) { i++; continue; }
        const inner = content.slice(i + 3, closeIdx).trim();
        const node = parseExpressionContent(inner, "BlockExpression", exprStart, closeIdx + 2, content, baseLine, baseColumn);
        node.children = [];
        node.inverse = [];

        // Check for each-in syntax: {{#each item in collection}}
        const eachInMatch = inner.match(/^each\s+(\w+)\s+in\s+(.+)$/);
        if (eachInMatch) {
          node.path = "each";
          node.blockParams = [eachInMatch[1]];
          const collectionExpr = eachInMatch[2].trim();
          node.params = [createPathParam(collectionExpr, exprStart, content, baseLine, baseColumn)];
          node.hash = {};
        }

        const closeTag = `{{/${node.path}}}`;
        blockStack.push({ node, closeTag });
        i = closeIdx + 2;
      } else if (content[i + 2] === '/') {
        // Block close {{/...}}
        const closeIdx = findClosingBraces(content, i + 3);
        if (closeIdx === -1) { i++; continue; }
        const closingName = content.slice(i + 3, closeIdx).trim();

        if (blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top.node.path === closingName) {
            blockStack.pop();
            // Update end position of the block node
            top.node.loc.end = offsetToPosition(content, closeIdx + 2, baseLine, baseColumn);
            pushToCurrentBlock(blockStack, expressions, top.node);
          }
        }
        i = closeIdx + 2;
      } else {
        // Check for {{else}}
        const closeIdx = findClosingBraces(content, i + 2);
        if (closeIdx === -1) { i++; continue; }
        const inner = content.slice(i + 2, closeIdx).trim();

        if (inner === "else") {
          if (blockStack.length > 0) {
            const top = blockStack[blockStack.length - 1];
            top._inInverse = true;
          }
          i = closeIdx + 2;
        } else {
          // Regular mustache expression {{...}}
          const node = parseExpressionContent(inner, "MustacheExpression", exprStart, closeIdx + 2, content, baseLine, baseColumn);
          pushToCurrentBlock(blockStack, expressions, node);
          i = closeIdx + 2;
        }
      }
    } else {
      i++;
    }
  }

  return expressions;
}

/**
 * Push a node to the current block's children (or inverse) or the top-level expressions list.
 * @param {any[]} blockStack
 * @param {SpacebarsNode[]} expressions
 * @param {SpacebarsNode} node
 */
function pushToCurrentBlock(blockStack, expressions, node) {
  if (blockStack.length > 0) {
    const top = blockStack[blockStack.length - 1];
    if (top._inInverse) {
      top.node.inverse.push(node);
    } else {
      top.node.children.push(node);
    }
  } else {
    expressions.push(node);
  }
}

/**
 * Find the closing `}}` for an expression, handling nested parens.
 * @param {string} content
 * @param {number} start
 * @returns {number} Index of the first `}` of `}}`, or -1
 */
function findClosingBraces(content, start) {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = start; i < content.length - 1; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === stringChar && content[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && ch === '}' && content[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse the inner content of a spacebars expression into a node.
 * @param {string} inner - Trimmed expression content
 * @param {SpacebarsNode["type"]} type
 * @param {number} exprStart - Start offset in content
 * @param {number} exprEnd - End offset in content
 * @param {string} content - Full template content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsNode}
 */
function parseExpressionContent(inner, type, exprStart, exprEnd, content, baseLine, baseColumn) {
  const tokens = tokenizeExpression(inner);
  const path = tokens.length > 0 ? tokens[0] : "";

  const innerStart = content.indexOf(inner, exprStart);

  /**
   * Find the offset of a token within content by searching from innerStart.
   * Uses a search cursor to handle duplicate tokens correctly.
   * @param {string} token
   * @param {number} searchFrom
   * @returns {number}
   */
  function findTokenOffset(token, searchFrom) {
    const idx = content.indexOf(token, searchFrom);
    return idx !== -1 ? idx : exprStart;
  }

  /** @type {SpacebarsParam[]} */
  const params = [];
  /** @type {Object<string, SpacebarsParam>} */
  const hash = {};

  let searchCursor = innerStart;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.includes('=') && !token.startsWith('"') && !token.startsWith("'") && !token.startsWith("(")) {
      const eqIdx = token.indexOf('=');
      const key = token.slice(0, eqIdx);
      const val = token.slice(eqIdx + 1);
      const tokenOffset = findTokenOffset(token, searchCursor);
      const valOffset = tokenOffset + eqIdx + 1;
      searchCursor = tokenOffset + token.length;
      // Hash values may be subexpressions: template=(template doc)
      hash[key] = parseParamToken(val, valOffset, content, baseLine, baseColumn);
    } else if (token.startsWith('(') && token.endsWith(')')) {
      const tokenOffset = findTokenOffset(token, searchCursor);
      searchCursor = tokenOffset + token.length;
      params.push(parseSubExpression(token, tokenOffset, content, baseLine, baseColumn));
    } else {
      const tokenOffset = findTokenOffset(token, searchCursor);
      searchCursor = tokenOffset + token.length;
      params.push(parseParamToken(token, tokenOffset, content, baseLine, baseColumn));
    }
  }

  return {
    type,
    path,
    params,
    hash,
    loc: offsetToRange(content, exprStart, exprEnd, baseLine, baseColumn)
  };
}

/**
 * Tokenize an expression's inner text, respecting quotes and parens.
 * @param {string} input
 * @returns {string[]}
 */
function tokenizeExpression(input) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let inString = false;
  let stringChar = '';
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      current += ch;
      if (ch === stringChar && input[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      current += ch;
      if (parenDepth === 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    if (/\s/.test(ch) || ch === '\n') {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Classify a token as a typed param, including parenthesized subexpressions.
 * @param {string} token
 * @param {number} exprStart
 * @param {string} content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsParam}
 */
function parseParamToken(token, exprStart, content, baseLine, baseColumn) {
  if (token.startsWith("(") && token.endsWith(")")) {
    return parseSubExpression(token, exprStart, content, baseLine, baseColumn);
  }
  return classifyParam(token, exprStart, content, baseLine, baseColumn);
}

/**
 * Parse `(helper arg1 arg2)` into a SubExpression param.
 * @param {string} token - Including surrounding parentheses
 * @param {number} tokenOffset
 * @param {string} content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsParam}
 */
function parseSubExpression(token, tokenOffset, content, baseLine, baseColumn) {
  const subInner = token.slice(1, -1).trim();
  const subTokens = tokenizeExpression(subInner);
  const innerStart = tokenOffset + token.indexOf(subInner);
  /** @type {SpacebarsParam[]} */
  const subParams = [];
  /** @type {Object<string, SpacebarsParam>} */
  const subHash = {};
  let searchFrom = innerStart;

  for (let i = 1; i < subTokens.length; i++) {
    const t = subTokens[i];
    const tOff = content.indexOf(t, searchFrom);
    const offset = tOff !== -1 ? tOff : searchFrom;
    searchFrom = offset + t.length;

    if (t.includes("=") && !t.startsWith('"') && !t.startsWith("'") && !t.startsWith("(")) {
      const eqIdx = t.indexOf("=");
      const key = t.slice(0, eqIdx);
      const val = t.slice(eqIdx + 1);
      subHash[key] = parseParamToken(val, offset + eqIdx + 1, content, baseLine, baseColumn);
    } else {
      subParams.push(parseParamToken(t, offset, content, baseLine, baseColumn));
    }
  }

  return {
    type: "SubExpression",
    value: subTokens[0] || "",
    loc: offsetToRange(content, tokenOffset, tokenOffset + token.length, baseLine, baseColumn),
    params: subParams,
    hash: subHash
  };
}

/**
 * Classify a token as a typed param.
 * @param {string} token
 * @param {number} exprStart
 * @param {string} content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsParam}
 */
function classifyParam(token, exprStart, content, baseLine, baseColumn) {
  const loc = offsetToRange(content, exprStart, exprStart + token.length, baseLine, baseColumn);

  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return { type: "StringLiteral", value: token.slice(1, -1), loc };
  }
  if (/^-?\d+(\.\d+)?$/.test(token)) {
    return { type: "NumberLiteral", value: token, loc };
  }
  if (token === "true" || token === "false") {
    return { type: "BooleanLiteral", value: token, loc };
  }
  return { type: "PathExpression", value: token, loc };
}

/**
 * Create a comment node.
 * @param {string} text
 * @param {number} exprStart
 * @param {number} exprEnd
 * @param {string} content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsNode}
 */
function createCommentNode(text, exprStart, exprEnd, content, baseLine, baseColumn) {
  return {
    type: "Comment",
    path: text,
    params: [],
    hash: {},
    loc: offsetToRange(content, exprStart, exprEnd, baseLine, baseColumn)
  };
}

/**
 * Create a path param (used for each-in expressions).
 * @param {string} value
 * @param {number} exprStart
 * @param {string} content
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SpacebarsParam}
 */
function createPathParam(value, exprStart, content, baseLine, baseColumn) {
  return {
    type: "PathExpression",
    value,
    loc: offsetToRange(content, exprStart, exprStart + value.length, baseLine, baseColumn)
  };
}

/**
 * Convert a byte offset in text to a {line, column} position.
 * @param {string} text
 * @param {number} offset
 * @param {number} [baseLine=0]
 * @param {number} [baseColumn=0]
 * @returns {Position}
 */
function offsetToPosition(text, offset, baseLine, baseColumn) {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  const column = offset - lastNewline - 1;
  if (baseLine !== undefined) {
    if (line === 0 && baseColumn !== undefined) {
      return { line: line + baseLine, column: column + baseColumn };
    }
    return { line: line + baseLine, column };
  }
  return { line, column };
}

/**
 * Create a SourceRange from start/end offsets in content.
 * @param {string} content
 * @param {number} startOffset
 * @param {number} endOffset
 * @param {number} baseLine
 * @param {number} baseColumn
 * @returns {SourceRange}
 */
function offsetToRange(content, startOffset, endOffset, baseLine, baseColumn) {
  return {
    start: offsetToPosition(content, startOffset, baseLine, baseColumn),
    end: offsetToPosition(content, endOffset, baseLine, baseColumn)
  };
}

/**
 * Extract included template names from parsed expressions.
 * @param {SpacebarsNode[]} expressions
 * @returns {string[]}
 */
function extractIncludedTemplates(expressions) {
  /** @type {string[]} */
  const names = [];
  for (const expr of expressions) {
    if (expr.type === "PartialExpression") {
      names.push(expr.path);
    }
    if (expr.children) {
      names.push(...extractIncludedTemplates(expr.children));
    }
    if (expr.inverse) {
      names.push(...extractIncludedTemplates(expr.inverse));
    }
  }
  return [...new Set(names)];
}

/**
 * Find which template a position falls inside, and what expression (if any) is at that position.
 * @param {TemplateBlock[]} templates
 * @param {number} line - 0-based
 * @param {number} column - 0-based
 * @returns {{ template: TemplateBlock|null, expression: SpacebarsNode|null, context: "path"|"hash"|"params"|null }}
 */
function getContextAtPosition(templates, line, column) {
  for (const template of templates) {
    if (isInsideRange(template.range, line, column)) {
      const expr = findExpressionAtPosition(template.expressions, line, column);
      let context = null;
      if (expr) {
        context = determineExpressionContext(expr, line, column);
      }
      return { template, expression: expr, context };
    }
  }
  return { template: null, expression: null, context: null };
}

/**
 * Check if a position is inside a range (inclusive).
 * @param {SourceRange} range
 * @param {number} line
 * @param {number} column
 * @returns {boolean}
 */
function isInsideRange(range, line, column) {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && column < range.start.column) return false;
  if (line === range.end.line && column > range.end.column) return false;
  return true;
}

/**
 * Recursively find the innermost expression at a position.
 * @param {SpacebarsNode[]} expressions
 * @param {number} line
 * @param {number} column
 * @returns {SpacebarsNode|null}
 */
function findExpressionAtPosition(expressions, line, column) {
  for (const expr of expressions) {
    if (isInsideRange(expr.loc, line, column)) {
      if (expr.children) {
        const child = findExpressionAtPosition(expr.children, line, column);
        if (child) return child;
      }
      if (expr.inverse) {
        const inv = findExpressionAtPosition(expr.inverse, line, column);
        if (inv) return inv;
      }
      return expr;
    }
  }
  return null;
}

/**
 * Determine what part of an expression the cursor is in.
 * @param {SpacebarsNode} expr
 * @param {number} line
 * @param {number} column
 * @returns {"path"|"hash"|"params"|null}
 */
function determineExpressionContext(expr, line, column) {
  for (const key of Object.keys(expr.hash)) {
    const param = expr.hash[key];
    if (isInsideRange(param.loc, line, column)) return "hash";
  }
  for (const param of expr.params) {
    if (isInsideRange(param.loc, line, column)) return "params";
  }
  return "path";
}

/**
 * Collect all expressions from templates recursively (flat list).
 * @param {SpacebarsNode[]} expressions
 * @returns {SpacebarsNode[]}
 */
function flattenExpressions(expressions) {
  /** @type {SpacebarsNode[]} */
  const result = [];
  for (const expr of expressions) {
    result.push(expr);
    if (expr.children) result.push(...flattenExpressions(expr.children));
    if (expr.inverse) result.push(...flattenExpressions(expr.inverse));
  }
  return result;
}

module.exports = {
  parseHTML,
  extractTemplateBlocks,
  parseSpacebarsExpressions,
  tokenizeExpression,
  getContextAtPosition,
  isInsideRange,
  findExpressionAtPosition,
  flattenExpressions,
  isInsideRange,
  offsetToPosition
};
