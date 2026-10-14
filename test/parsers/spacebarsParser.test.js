// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {
  parseHTML,
  extractTemplateBlocks,
  parseSpacebarsExpressions,
  tokenizeExpression,
  getContextAtPosition,
  flattenExpressions,
  offsetToPosition
} = require("../../server/parsers/spacebarsParser");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("offsetToPosition", () => {
  it("should return line 0, column 0 for offset 0", () => {
    const pos = offsetToPosition("hello", 0);
    assert.deepEqual(pos, { line: 0, column: 0 });
  });

  it("should handle newlines", () => {
    const text = "line1\nline2\nline3";
    assert.deepEqual(offsetToPosition(text, 6), { line: 1, column: 0 });
    assert.deepEqual(offsetToPosition(text, 8), { line: 1, column: 2 });
    assert.deepEqual(offsetToPosition(text, 12), { line: 2, column: 0 });
  });
});

describe("tokenizeExpression", () => {
  it("should split simple tokens", () => {
    assert.deepEqual(tokenizeExpression("helperName"), ["helperName"]);
  });

  it("should split multiple tokens", () => {
    assert.deepEqual(tokenizeExpression("helper arg1 arg2"), ["helper", "arg1", "arg2"]);
  });

  it("should handle key=value pairs", () => {
    const tokens = tokenizeExpression('toggleButton id="plane-mode" checked=notConnected');
    assert.deepEqual(tokens, ["toggleButton", 'id="plane-mode"', "checked=notConnected"]);
  });

  it("should handle quoted strings with spaces", () => {
    const tokens = tokenizeExpression('helper "hello world" arg2');
    assert.deepEqual(tokens, ["helper", '"hello world"', "arg2"]);
  });

  it("should handle sub-expressions in parens", () => {
    const tokens = tokenizeExpression("helper (subHelper arg)");
    assert.deepEqual(tokens, ["helper", "(subHelper arg)"]);
  });

  it("should handle multiline expressions", () => {
    const tokens = tokenizeExpression('toggleButton\n  id="plane-mode"\n  checked=val');
    assert.deepEqual(tokens, ["toggleButton", 'id="plane-mode"', "checked=val"]);
  });
});

describe("extractTemplateBlocks", () => {
  it("should extract a single template", () => {
    const source = '<template name="myTemplate">\n  <div>hello</div>\n</template>';
    const blocks = extractTemplateBlocks(source);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].name, "myTemplate");
    assert.equal(blocks[0].range.start.line, 0);
    assert.equal(blocks[0].range.start.column, 0);
  });

  it("should extract multiple templates", () => {
    const source = '<template name="a">\n  content A\n</template>\n<template name="b">\n  content B\n</template>';
    const blocks = extractTemplateBlocks(source);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].name, "a");
    assert.equal(blocks[1].name, "b");
  });

  it("should handle single-quoted template names", () => {
    const source = "<template name='myTpl'>\n  content\n</template>";
    const blocks = extractTemplateBlocks(source);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].name, "myTpl");
  });

  it("should set correct content start position", () => {
    const source = '<template name="test">\ncontent\n</template>';
    const blocks = extractTemplateBlocks(source);
    assert.equal(blocks[0].contentStartLine, 0);
    assert.equal(blocks[0].content, "\ncontent\n");
  });
});

describe("parseHTML — simple expressions", () => {
  it("should parse a simple mustache expression", () => {
    const source = '<template name="t">\n  {{name}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].expressions.length, 1);
    assert.equal(templates[0].expressions[0].type, "MustacheExpression");
    assert.equal(templates[0].expressions[0].path, "name");
  });

  it("should parse a raw expression", () => {
    const source = '<template name="t">\n  {{{htmlContent}}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates[0].expressions.length, 1);
    assert.equal(templates[0].expressions[0].type, "RawExpression");
    assert.equal(templates[0].expressions[0].path, "htmlContent");
  });

  it("should parse a partial expression", () => {
    const source = '<template name="t">\n  {{> myPartial}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates[0].expressions.length, 1);
    assert.equal(templates[0].expressions[0].type, "PartialExpression");
    assert.equal(templates[0].expressions[0].path, "myPartial");
  });

  it("should parse a partial with hash arguments", () => {
    const source = '<template name="t">\n  {{> toggle checked=val text="hello"}}\n</template>';
    const templates = parseHTML(source);
    const expr = templates[0].expressions[0];
    assert.equal(expr.type, "PartialExpression");
    assert.equal(expr.path, "toggle");
    assert.ok(expr.hash.checked);
    assert.equal(expr.hash.checked.type, "PathExpression");
    assert.equal(expr.hash.checked.value, "val");
    assert.ok(expr.hash.text);
    assert.equal(expr.hash.text.type, "StringLiteral");
    assert.equal(expr.hash.text.value, "hello");
  });

  it("should parse a mustache with positional arguments", () => {
    const source = '<template name="t">\n  {{formatDate date "YYYY"}}\n</template>';
    const templates = parseHTML(source);
    const expr = templates[0].expressions[0];
    assert.equal(expr.path, "formatDate");
    assert.equal(expr.params.length, 2);
    assert.equal(expr.params[0].type, "PathExpression");
    assert.equal(expr.params[0].value, "date");
    assert.equal(expr.params[1].type, "StringLiteral");
    assert.equal(expr.params[1].value, "YYYY");
  });

  it("should parse comments", () => {
    const source = '<template name="t">\n  {{! this is a comment}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates[0].expressions.length, 1);
    assert.equal(templates[0].expressions[0].type, "Comment");
  });

  it("should parse long comments", () => {
    const source = '<template name="t">\n  {{!-- this is a long comment --}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates[0].expressions.length, 1);
    assert.equal(templates[0].expressions[0].type, "Comment");
  });
});

describe("parseHTML — block expressions", () => {
  it("should parse #if block", () => {
    const source = '<template name="t">\n  {{#if ready}}\n    <div>ready</div>\n  {{/if}}\n</template>';
    const templates = parseHTML(source);
    assert.equal(templates[0].expressions.length, 1);
    const block = templates[0].expressions[0];
    assert.equal(block.type, "BlockExpression");
    assert.equal(block.path, "if");
    assert.equal(block.params[0].value, "ready");
  });

  it("should parse #if with else", () => {
    const source = '<template name="t">\n  {{#if ready}}\n    {{name}}\n  {{else}}\n    {{loading}}\n  {{/if}}\n</template>';
    const templates = parseHTML(source);
    const block = templates[0].expressions[0];
    assert.equal(block.type, "BlockExpression");
    assert.equal(block.children.length, 1);
    assert.equal(block.children[0].path, "name");
    assert.equal(block.inverse.length, 1);
    assert.equal(block.inverse[0].path, "loading");
  });

  it("should parse #each with in syntax", () => {
    const source = '<template name="t">\n  {{#each item in items}}\n    {{item.name}}\n  {{/each}}\n</template>';
    const templates = parseHTML(source);
    const block = templates[0].expressions[0];
    assert.equal(block.type, "BlockExpression");
    assert.equal(block.path, "each");
    assert.deepEqual(block.blockParams, ["item"]);
    assert.equal(block.params[0].value, "items");
    assert.equal(block.children.length, 1);
    assert.equal(block.children[0].path, "item.name");
  });

  it("should parse nested blocks", () => {
    const source = '<template name="t">\n  {{#if a}}\n    {{#if b}}\n      {{val}}\n    {{/if}}\n  {{/if}}\n</template>';
    const templates = parseHTML(source);
    const outer = templates[0].expressions[0];
    assert.equal(outer.path, "if");
    assert.equal(outer.children.length, 1);
    const inner = outer.children[0];
    assert.equal(inner.path, "if");
    assert.equal(inner.children.length, 1);
    assert.equal(inner.children[0].path, "val");
  });

  it("should parse #unless block", () => {
    const source = '<template name="t">\n  {{#unless done}}\n    {{pending}}\n  {{/unless}}\n</template>';
    const templates = parseHTML(source);
    const block = templates[0].expressions[0];
    assert.equal(block.type, "BlockExpression");
    assert.equal(block.path, "unless");
  });
});

describe("parseHTML — included templates", () => {
  it("should extract included template names", () => {
    const source = '<template name="t">\n  {{> header}}\n  {{> footer}}\n</template>';
    const templates = parseHTML(source);
    assert.deepEqual(templates[0].includedTemplates, ["header", "footer"]);
  });

  it("should extract included templates from blocks", () => {
    const source = '<template name="t">\n  {{#if show}}\n    {{> child}}\n  {{/if}}\n</template>';
    const templates = parseHTML(source);
    assert.deepEqual(templates[0].includedTemplates, ["child"]);
  });

  it("should deduplicate included template names", () => {
    const source = '<template name="t">\n  {{> header}}\n  {{> header}}\n</template>';
    const templates = parseHTML(source);
    assert.deepEqual(templates[0].includedTemplates, ["header"]);
  });
});

describe("parseHTML — fixture files", () => {
  it("should parse toggle.html fixture", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.html"), "utf-8");
    const templates = parseHTML(source);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "toggleButton");

    const flat = flattenExpressions(templates[0].expressions);
    const paths = flat.filter(e => e.type !== "Comment").map(e => e.path);
    assert.ok(paths.includes("target"), "should find target expression");
    assert.ok(paths.includes("isChecked"), "should find isChecked helper");
    assert.ok(paths.includes("if"), "should find #if blocks");
    assert.ok(paths.includes("html"), "should find html data field");
    assert.ok(paths.includes("text"), "should find text data field");
    assert.ok(paths.includes("icon"), "should find icon raw expression");
  });

  it("should parse colorPicker.html fixture with each-in", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "colorPicker.html"), "utf-8");
    const templates = parseHTML(source);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "noteColorPicker");

    const flat = flattenExpressions(templates[0].expressions);
    const eachBlock = flat.find(e => e.path === "each");
    assert.ok(eachBlock, "should have each block");
    assert.deepEqual(eachBlock.blockParams, ["color"]);
    assert.equal(eachBlock.params[0].value, "colors");
  });

  it("should parse complex index.html with nested blocks and partials", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "complex", "index.html"), "utf-8");
    const templates = parseHTML(source);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "index");

    assert.ok(templates[0].includedTemplates.includes("toggleButton"), "should include toggleButton");
    assert.ok(templates[0].includedTemplates.includes("cardsContainer"), "should include cardsContainer");
  });
});

describe("flattenExpressions", () => {
  it("should flatten nested block expressions", () => {
    const source = '<template name="t">\n  {{#if a}}\n    {{b}}\n    {{#each x in c}}\n      {{d}}\n    {{/each}}\n  {{/if}}\n</template>';
    const templates = parseHTML(source);
    const flat = flattenExpressions(templates[0].expressions);
    const paths = flat.map(e => e.path);
    assert.ok(paths.includes("if"));
    assert.ok(paths.includes("b"));
    assert.ok(paths.includes("each"));
    assert.ok(paths.includes("d"));
  });
});

describe("getContextAtPosition", () => {
  it("should find the template at a position", () => {
    const source = '<template name="t">\n  {{name}}\n</template>';
    const templates = parseHTML(source);
    const result = getContextAtPosition(templates, 1, 5);
    assert.ok(result.template);
    assert.equal(result.template.name, "t");
    assert.ok(result.expression);
    assert.equal(result.expression.path, "name");
  });

  it("should return null for positions outside templates", () => {
    const source = 'before\n<template name="t">\n  {{name}}\n</template>\nafter';
    const templates = parseHTML(source);
    const result = getContextAtPosition(templates, 0, 0);
    assert.equal(result.template, null);
  });
});

describe("parseHTML — source positions", () => {
  it("should have correct line numbers for expressions", () => {
    const source = '<template name="t">\n  {{first}}\n  {{second}}\n</template>';
    const templates = parseHTML(source);
    const [first, second] = templates[0].expressions;
    assert.equal(first.loc.start.line, 1, "first expression on line 1");
    assert.equal(second.loc.start.line, 2, "second expression on line 2");
  });
});

describe("parseHTML — Template.dynamic", () => {
  it("should parse Template.dynamic partial", () => {
    const source = '<template name="t">\n  {{> Template.dynamic template=section.template data=section.data}}\n</template>';
    const templates = parseHTML(source);
    const expr = templates[0].expressions[0];
    assert.equal(expr.type, "PartialExpression");
    assert.equal(expr.path, "Template.dynamic");
    assert.ok(expr.hash.template);
    assert.ok(expr.hash.data);
  });

  it("should parse hash subexpressions like template=(template doc)", () => {
    const source = '<template name="t">\n  {{> Template.dynamic template=(template doc) data=doc}}\n</template>';
    const templates = parseHTML(source);
    const expr = templates[0].expressions[0];
    assert.equal(expr.hash.template.type, "SubExpression");
    assert.equal(expr.hash.template.value, "template");
    assert.equal(expr.hash.template.params.length, 1);
    assert.equal(expr.hash.template.params[0].value, "doc");
    assert.equal(expr.hash.data.type, "PathExpression");
    assert.equal(expr.hash.data.value, "doc");
  });
});
