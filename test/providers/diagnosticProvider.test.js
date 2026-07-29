// @ts-check
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const { getDiagnostics } = require("../../server/providers/diagnosticProvider");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("getDiagnostics", () => {
  /** @type {ProjectIndex} */
  let index;

  beforeEach(() => {
    index = new ProjectIndex(fixturesDir);
    index.scan();
  });

  it("should report no diagnostics for valid template", () => {
    const source = '<template name="toggleButton">\n  {{isChecked}}\n  {{text}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.equal(diags.length, 0);
  });

  it("should report unknown helper/data field", () => {
    const source = '<template name="toggleButton">\n  {{unknownHelper}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.ok(diags.length > 0);
    assert.ok(diags.some(d => d.message.includes("unknownHelper")));
    // Warning severity = 2
    assert.equal(diags[0].severity, 2);
  });

  it("should report unknown template in partial", () => {
    const source = '<template name="toggleButton">\n  {{> nonExistentTemplate}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.ok(diags.some(d => d.message.includes("nonExistentTemplate")));
    // Error severity = 1
    const templateDiag = diags.find(d => d.message.includes("nonExistentTemplate"));
    assert.equal(templateDiag.severity, 1);
  });

  it("should not report built-in helpers", () => {
    const source = '<template name="toggleButton">\n  {{#if isChecked}}\n    active\n  {{/if}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.ok(!diags.some(d => d.message.includes('"if"')));
  });

  it("should report missing component registration", () => {
    const source = '<template name="unregisteredTemplate">\n  {{something}}\n</template>';
    index.updateFile("/test/unreg.html", source);

    const diags = getDiagnostics(index, "/test/unreg.html", source);
    assert.ok(diags.some(d => d.message.includes("no BlazeComponent registered")));
    // Info severity = 3
    const infoDiag = diags.find(d => d.message.includes("no BlazeComponent"));
    assert.equal(infoDiag.severity, 3);
  });

  it("should not report dotted paths", () => {
    const source = '<template name="toggleButton">\n  {{item.name}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.ok(!diags.some(d => d.message.includes("item.name")));
  });

  it("should not report known context data fields", () => {
    const source = '<template name="toggleButton">\n  {{html}}\n  {{target}}\n  {{checked}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.equal(diags.length, 0);
  });

  it("should not report comments", () => {
    const source = '<template name="toggleButton">\n  {{! some comment}}\n</template>';
    index.updateFile("/test/toggle.html", source);

    const diags = getDiagnostics(index, "/test/toggle.html", source);
    assert.equal(diags.length, 0);
  });

  it("should not report known template partials", () => {
    const source = '<template name="test">\n  {{> toggleButton}}\n</template>';
    index.updateFile("/test/test.html", source);

    const diags = getDiagnostics(index, "/test/test.html", source);
    const templateDiags = diags.filter(d => d.message.includes("is not defined"));
    assert.equal(templateDiags.length, 0);
  });
});
