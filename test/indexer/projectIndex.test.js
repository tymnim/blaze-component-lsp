// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("ProjectIndex", () => {
  it("should scan a directory and find templates and components", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    assert.ok(index.getTemplate("toggleButton"), "should find toggleButton template");
    assert.ok(index.getTemplate("noteColorPicker"), "should find noteColorPicker template");
    assert.ok(index.getComponentForTemplate("toggleButton"), "should find toggleButton component");
    assert.ok(index.getComponentForTemplate("noteColorPicker"), "should find noteColorPicker component");
  });

  it("should return all template names", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    const names = index.getAllTemplateNames();
    assert.ok(names.includes("toggleButton"));
    assert.ok(names.includes("noteColorPicker"));
  });

  it("should get available identifiers for a template", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    const { helpers, contextFields } = index.getAvailableIdentifiers("toggleButton");
    assert.ok(helpers.length > 0, "should have helpers");
    assert.ok(contextFields.length > 0, "should have context fields");
    assert.ok(helpers.some(h => h.name === "isChecked"));
    assert.ok(contextFields.some(f => f.name === "text"));
  });

  it("should return empty identifiers for unknown template", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    const { helpers, contextFields } = index.getAvailableIdentifiers("nonExistent");
    assert.equal(helpers.length, 0);
    assert.equal(contextFields.length, 0);
  });

  it("should update a file", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();

    index.updateFile("/fake/new.html", '<template name="dynamicTpl">\n  {{foo}}\n</template>');
    assert.ok(index.getTemplate("dynamicTpl"));
  });

  it("should remove a file", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();

    const htmlPath = path.join(fixturesDir, "simple", "toggle.html");
    index.removeFile(htmlPath);
    assert.equal(index.getTemplate("toggleButton"), undefined);
  });

  it("should find helper references across templates", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    const refs = index.findHelperReferences("isChecked");
    assert.ok(refs.length > 0, "should find isChecked usage in toggle.html");
    assert.ok(refs.some(r => r.templateName === "toggleButton"));
  });

  it("should find template references (partial inclusions)", () => {
    const index = new ProjectIndex(path.join(fixturesDir));
    index.scan();
    const refs = index.findTemplateReferences("toggleButton");
    assert.ok(refs.length > 0, "should find toggleButton inclusion in index.html");
    assert.ok(refs.some(r => r.fromTemplate === "index"));
  });

  it("should scan complex fixtures", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "complex"));
    index.scan();
    const comp = index.getComponentForTemplate("index");
    assert.ok(comp);
    assert.ok(comp.helpers.some(h => h.name === "assignments"));
    assert.ok(comp.events.some(e => e.selector === "click .dashboard-section-sort"));
  });

  it("should get templates in a specific file", () => {
    const index = new ProjectIndex(path.join(fixturesDir, "simple"));
    index.scan();
    const htmlPath = path.join(fixturesDir, "simple", "toggle.html");
    const templates = index.getTemplatesInFile(htmlPath);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "toggleButton");
  });
});
