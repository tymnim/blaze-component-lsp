// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { TemplateIndexer } = require("../../server/indexer/templateIndexer");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("TemplateIndexer", () => {
  it("should index an HTML file", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.html"));
    assert.equal(indexer.size, 1);
    assert.ok(indexer.getTemplate("toggleButton"));
  });

  it("should return the template name", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.html"));
    const tpl = indexer.getTemplate("toggleButton");
    assert.equal(tpl.name, "toggleButton");
  });

  it("should index multiple files", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.html"));
    indexer.indexFile(path.join(fixturesDir, "simple", "colorPicker.html"));
    assert.equal(indexer.size, 2);
    assert.ok(indexer.getTemplate("toggleButton"));
    assert.ok(indexer.getTemplate("noteColorPicker"));
  });

  it("should list all template names", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.html"));
    indexer.indexFile(path.join(fixturesDir, "simple", "colorPicker.html"));
    const names = indexer.getAllTemplateNames();
    assert.ok(names.includes("toggleButton"));
    assert.ok(names.includes("noteColorPicker"));
  });

  it("should remove a file from the index", () => {
    const indexer = new TemplateIndexer();
    const filePath = path.join(fixturesDir, "simple", "toggle.html");
    indexer.indexFile(filePath);
    assert.equal(indexer.size, 1);
    indexer.removeFile(filePath);
    assert.equal(indexer.size, 0);
    assert.equal(indexer.getTemplate("toggleButton"), undefined);
  });

  it("should re-index a file on update", () => {
    const indexer = new TemplateIndexer();
    const filePath = path.join(fixturesDir, "simple", "toggle.html");
    indexer.indexFile(filePath);
    assert.equal(indexer.size, 1);
    indexer.indexFile(filePath, '<template name="newName">\n  {{foo}}\n</template>');
    assert.equal(indexer.size, 1);
    assert.equal(indexer.getTemplate("toggleButton"), undefined);
    assert.ok(indexer.getTemplate("newName"));
  });

  it("should index from source string", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile("/fake/path.html", '<template name="test">\n  {{hello}}\n</template>');
    assert.equal(indexer.size, 1);
    const tpl = indexer.getTemplate("test");
    assert.ok(tpl);
    assert.equal(tpl.expressions.length, 1);
    assert.equal(tpl.expressions[0].path, "hello");
  });

  it("should get templates in a specific file", () => {
    const indexer = new TemplateIndexer();
    const filePath = path.join(fixturesDir, "simple", "toggle.html");
    indexer.indexFile(filePath);
    const templates = indexer.getTemplatesInFile(filePath);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "toggleButton");
  });

  it("should return empty array for unknown file", () => {
    const indexer = new TemplateIndexer();
    const templates = indexer.getTemplatesInFile("/nonexistent/file.html");
    assert.equal(templates.length, 0);
  });

  it("should extract included templates", () => {
    const indexer = new TemplateIndexer();
    indexer.indexFile(path.join(fixturesDir, "complex", "index.html"));
    const tpl = indexer.getTemplate("index");
    assert.ok(tpl.includedTemplates.includes("toggleButton"));
    assert.ok(tpl.includedTemplates.includes("cardsContainer"));
  });
});
