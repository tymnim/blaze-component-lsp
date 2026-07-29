// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ComponentIndexer } = require("../../server/indexer/componentIndexer");

const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("ComponentIndexer", () => {
  it("should index a JS file with explicit registration", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "colorPicker.js"));
    assert.equal(indexer.size, 1);
    assert.ok(indexer.getComponent("noteColorPicker"));
  });

  it("should index a JS file with decorator registration", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    assert.equal(indexer.size, 1);
    assert.ok(indexer.getComponent("toggleButton"));
  });

  it("should index multiple files", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    indexer.indexFile(path.join(fixturesDir, "simple", "colorPicker.js"));
    assert.equal(indexer.size, 2);
  });

  it("should remove a file from the index", () => {
    const indexer = new ComponentIndexer();
    const filePath = path.join(fixturesDir, "simple", "toggle.js");
    indexer.indexFile(filePath);
    assert.equal(indexer.size, 1);
    indexer.removeFile(filePath);
    assert.equal(indexer.size, 0);
  });

  it("should return helpers for a component", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    const comp = indexer.getComponent("toggleButton");
    const helperNames = comp.helpers.map(h => h.name);
    assert.ok(helperNames.includes("isChecked"));
  });

  it("should return events for a component", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    const comp = indexer.getComponent("toggleButton");
    assert.equal(comp.events.length, 1);
    assert.equal(comp.events[0].selector, "click .toggle-button");
  });

  it("should return context data fields for a component", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    const comp = indexer.getComponent("toggleButton");
    const fieldNames = comp.contextDataFields.map(f => f.name);
    assert.ok(fieldNames.includes("html"));
    assert.ok(fieldNames.includes("text"));
  });

  it("should list all template names", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile(path.join(fixturesDir, "simple", "toggle.js"));
    indexer.indexFile(path.join(fixturesDir, "simple", "colorPicker.js"));
    const names = indexer.getAllTemplateNames();
    assert.ok(names.includes("toggleButton"));
    assert.ok(names.includes("noteColorPicker"));
  });

  it("should not index files without BlazeComponent", () => {
    const indexer = new ComponentIndexer();
    indexer.indexFile("/fake/file.js", "export function foo() {}");
    assert.equal(indexer.size, 0);
  });
});
