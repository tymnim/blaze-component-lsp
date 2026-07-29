// @ts-check
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const { getDefinition } = require("../../server/providers/definitionProvider");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("getDefinition", () => {
  /** @type {ProjectIndex} */
  let index;

  beforeEach(() => {
    index = new ProjectIndex(fixturesDir);
    index.scan();
  });

  it("should go to helper method definition", () => {
    const source = '<template name="toggleButton">\n  {{isChecked}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const result = getDefinition(index, "/test/toggle.html", source, 1, 6);
    assert.ok(result);
    assert.ok(result.length > 0);
    const loc = result[0];
    assert.ok(loc.uri.includes("toggle.js"));
  });

  it("should go to context data field definition", () => {
    const source = '<template name="toggleButton">\n  {{text}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const result = getDefinition(index, "/test/toggle.html", source, 1, 5);
    assert.ok(result);
    assert.ok(result.length > 0);
    const loc = result[0];
    assert.ok(loc.uri.includes("toggle.js"));
  });

  it("should go to template definition for partials", () => {
    const source = '<template name="index">\n  {{> toggleButton}}\n</template>';
    index.updateFile("/test/index.html", source);

    const result = getDefinition(index, "/test/index.html", source, 1, 8);
    assert.ok(result);
    assert.ok(result.length > 0);
    // Should have both HTML template and JS component locations
    const uris = result.map(r => r.uri);
    assert.ok(uris.some(u => u.includes("toggle.html")), "should have HTML location");
    assert.ok(uris.some(u => u.includes("toggle.js")), "should have JS location");
  });

  it("should return null for Template.dynamic", () => {
    const source = '<template name="test">\n  {{> Template.dynamic template=x}}\n</template>';
    index.updateFile("/test/test.html", source);

    const result = getDefinition(index, "/test/test.html", source, 1, 10);
    assert.equal(result, null);
  });

  it("should return null for positions outside expressions", () => {
    const source = '<template name="test">\n  <div>hello</div>\n</template>';
    const result = getDefinition(index, "/test/test.html", source, 1, 8);
    assert.equal(result, null);
  });

  it("should return null for unknown identifiers", () => {
    const source = '<template name="toggleButton">\n  {{unknownThing}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const result = getDefinition(index, "/test/toggle.html", source, 1, 6);
    assert.equal(result, null);
  });
});
