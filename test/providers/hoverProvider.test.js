// @ts-check
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const { getHover } = require("../../server/providers/hoverProvider");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("getHover", () => {
  /** @type {ProjectIndex} */
  let index;

  beforeEach(() => {
    index = new ProjectIndex(fixturesDir);
    index.scan();
  });

  it("should show hover for a helper", () => {
    const source = '<template name="toggleButton">\n  {{isChecked}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const result = getHover(index, "/test/toggle.html", source, 1, 6);
    assert.ok(result);
    assert.ok(result.contents.includes("isChecked"));
    assert.ok(result.contents.includes("Helper"));
  });

  it("should show hover for a context data field", () => {
    const source = '<template name="toggleButton">\n  {{text}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const result = getHover(index, "/test/toggle.html", source, 1, 5);
    assert.ok(result);
    assert.ok(result.contents.includes("text"));
    assert.ok(result.contents.includes("Context Data"));
    assert.ok(result.contents.includes("string"));
  });

  it("should show hover for a partial inclusion", () => {
    const source = '<template name="index">\n  {{> toggleButton}}\n</template>';
    index.updateFile("/test/index.html", source);

    const result = getHover(index, "/test/index.html", source, 1, 8);
    assert.ok(result);
    assert.ok(result.contents.includes("toggleButton"));
    assert.ok(result.contents.includes("Template"));
  });

  it("should show hover for built-in block helpers", () => {
    const source = '<template name="test">\n  {{#if something}}\n    hello\n  {{/if}}\n</template>';
    index.updateFile("/test/test.html", source);

    const result = getHover(index, "/test/test.html", source, 1, 6);
    assert.ok(result);
    assert.ok(result.contents.includes("#if"));
    assert.ok(result.contents.includes("Built-in"));
  });

  it("should show hover for Template.dynamic", () => {
    const source = '<template name="test">\n  {{> Template.dynamic template=x data=y}}\n</template>';
    index.updateFile("/test/test.html", source);

    const result = getHover(index, "/test/test.html", source, 1, 10);
    assert.ok(result);
    assert.ok(result.contents.includes("Template.dynamic"));
  });

  it("should return null for positions outside expressions", () => {
    const source = '<template name="test">\n  <div>hello</div>\n</template>';
    const result = getHover(index, "/test/test.html", source, 1, 8);
    assert.equal(result, null);
  });

  it("should return null for comments", () => {
    const source = '<template name="test">\n  {{! comment}}\n</template>';
    index.updateFile("/test/test.html", source);

    const result = getHover(index, "/test/test.html", source, 1, 8);
    assert.equal(result, null);
  });

  it("should show context data fields in partial hover", () => {
    const source = '<template name="index">\n  {{> toggleButton}}\n</template>';
    index.updateFile("/test/index.html", source);

    const result = getHover(index, "/test/index.html", source, 1, 8);
    assert.ok(result);
    assert.ok(result.contents.includes("Context Data"));
    assert.ok(result.contents.includes("checked"));
  });
});
