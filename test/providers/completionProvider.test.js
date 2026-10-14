// @ts-check
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const {
  getCompletions,
  isInsidePartialTag,
  isInsideMustache,
  isInsideBlockOpen,
  isAfterPartialName
} = require("../../server/providers/completionProvider");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("isInsidePartialTag", () => {
  it("should detect inside partial", () => {
    assert.ok(isInsidePartialTag("  {{> "));
    assert.ok(isInsidePartialTag("  {{> toggle"));
    assert.ok(isInsidePartialTag("  {{> toggle checked="));
  });

  it("should not detect outside partial", () => {
    assert.ok(!isInsidePartialTag("  {{ "));
    assert.ok(!isInsidePartialTag("  {{> toggle}}  "));
    assert.ok(!isInsidePartialTag("normal text"));
  });
});

describe("isInsideMustache", () => {
  it("should detect inside mustache", () => {
    assert.ok(isInsideMustache("  {{"));
    assert.ok(isInsideMustache("  {{name"));
  });

  it("should not detect outside mustache", () => {
    assert.ok(!isInsideMustache("  {{name}}"));
    assert.ok(!isInsideMustache("normal text"));
  });

  it("should not detect inside partial/comment/close/block", () => {
    assert.ok(!isInsideMustache("  {{> "));
    assert.ok(!isInsideMustache("  {{! "));
    assert.ok(!isInsideMustache("  {{/ "));
    assert.ok(!isInsideMustache("  {{#if "));
  });
});

describe("isInsideBlockOpen", () => {
  it("should detect inside block open", () => {
    assert.ok(isInsideBlockOpen("  {{#"));
    assert.ok(isInsideBlockOpen("  {{#if "));
    assert.ok(isInsideBlockOpen("  {{#each item in"));
    assert.ok(isInsideBlockOpen("  {{#require"));
  });

  it("should not detect outside block open", () => {
    assert.ok(!isInsideBlockOpen("  {{#if}}"));
    assert.ok(!isInsideBlockOpen("  {{name"));
    assert.ok(!isInsideBlockOpen("  {{> partial"));
    assert.ok(!isInsideBlockOpen("normal text"));
  });
});

describe("isAfterPartialName", () => {
  it("should detect after name with space", () => {
    assert.ok(isAfterPartialName("  {{> toggle "));
    assert.ok(isAfterPartialName("  {{> toggle checked="));
  });

  it("should not detect when still typing name", () => {
    assert.ok(!isAfterPartialName("  {{> tog"));
    assert.ok(!isAfterPartialName("  {{> "));
  });
});

describe("getCompletions", () => {
  /** @type {ProjectIndex} */
  let index;

  beforeEach(() => {
    index = new ProjectIndex(fixturesDir);
    index.scan();
  });

  it("should provide helper and data field completions inside {{", () => {
    const source = '<template name="toggleButton">\n  {{i\n</template>';
    index.updateFile("/test/toggle.html", source);

    const completions = getCompletions(index, "/test/toggle.html", source, 1, 4);
    assert.ok(completions.length > 0);

    const labels = completions.map(c => c.label);
    assert.ok(labels.includes("isChecked"), "should suggest isChecked helper");
    assert.ok(labels.includes("text"), "should suggest text context field");
    assert.ok(labels.includes("html"), "should suggest html context field");
    assert.ok(labels.includes("if"), "should suggest built-in if");
  });

  it("should provide template name completions inside {{>", () => {
    const source = '<template name="test">\n  {{> \n</template>';
    index.updateFile("/test/test.html", source);

    const completions = getCompletions(index, "/test/test.html", source, 1, 6);
    const labels = completions.map(c => c.label);
    assert.ok(labels.includes("toggleButton"), "should suggest toggleButton template");
    assert.ok(labels.includes("noteColorPicker"), "should suggest noteColorPicker template");
  });

  it("should provide context field completions for partial hash arguments", () => {
    const source = '<template name="test">\n  {{> toggleButton c\n</template>';
    index.updateFile("/test/test.html", source);

    const completions = getCompletions(index, "/test/test.html", source, 1, 21);
    const labels = completions.map(c => c.label);
    assert.ok(labels.includes("checked"), "should suggest checked field");
    assert.ok(labels.includes("text"), "should suggest text field");
  });

  it("should suggest current template helpers and fields as positional partial args", () => {
    // {{> cardsContainer recruits}} — suggest helpers/fields from *this* template
    const source = '<template name="toggleButton">\n  {{> noteColorPicker i\n</template>';
    index.updateFile("/test/toggle.html", source);

    const completions = getCompletions(index, "/test/toggle.html", source, 1, 24);
    const labels = completions.map(c => c.label);
    assert.ok(labels.includes("isChecked"), "should suggest current helper isChecked");
    assert.ok(labels.includes("text"), "should suggest current context field text");
    assert.ok(labels.includes("html"), "should suggest current context field html");
    assert.ok(!labels.includes("if"), "should not suggest block builtins as positional args");

    const helperItem = completions.find(c => c.label === "isChecked");
    assert.ok(helperItem);
    assert.equal(helperItem.kind, 3); // Function — not a hash key insert
    assert.ok(!helperItem.insertText || !String(helperItem.insertText).endsWith("="));
  });

  it("should still suggest target ContextData keys alongside current identifiers", () => {
    const source = '<template name="noteColorPicker">\n  {{> toggleButton \n</template>';
    index.updateFile("/test/colorPicker.html", source);

    const completions = getCompletions(index, "/test/colorPicker.html", source, 1, 20);
    const hashKey = completions.find(c => c.insertText === "checked=");
    assert.ok(hashKey, "should still offer target ContextData keys with =");
    assert.ok(completions.some(c => c.label === "colors"), "should also offer current helpers");
    assert.ok(completions.some(c => c.label === "currentColorCSS"), "should also offer current helpers");
  });

  it("should return empty for positions outside expressions", () => {
    const source = '<template name="toggleButton">\n  <div>hello</div>\n</template>';
    const completions = getCompletions(index, "/test/toggle.html", source, 1, 8);
    assert.equal(completions.length, 0);
  });

  it("should include completion item kinds", () => {
    const source = '<template name="toggleButton">\n  {{\n</template>';
    index.updateFile("/test/toggle.html", source);

    const completions = getCompletions(index, "/test/toggle.html", source, 1, 4);
    const helperItem = completions.find(c => c.label === "isChecked");
    const fieldItem = completions.find(c => c.label === "text");

    assert.ok(helperItem);
    assert.ok(fieldItem);
    // CompletionItemKind.Function = 3, Field = 5
    assert.equal(helperItem.kind, 3);
    assert.equal(fieldItem.kind, 5);
  });
});
