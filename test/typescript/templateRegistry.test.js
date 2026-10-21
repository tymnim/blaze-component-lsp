// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const { getDiagnostics } = require("../../server/providers/diagnosticProvider");
const {
  generateRegistrySource,
  getRegistryPath
} = require("../../server/typescript/templateRegistryEmitter");
const {
  elementTypeFromArrayTypeString,
  hasTemplateDataShape,
  classifyTemplateNameType
} = require("../../server/typescript/spacebarsTypeScope");

const typedRoot = path.join(__dirname, "..", "typed-project");

describe("template registry emitter", () => {
  it("should generate TemplateContextMap with known templates", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const src = generateRegistrySource(index);
    assert.ok(src.includes("declare module \"blaze-component-lsp\""));
    assert.ok(src.includes("interface TemplateContextMap"));
    assert.ok(src.includes("\"toggleButton\""));
    assert.ok(src.includes("\"template1\""));
    assert.ok(src.includes("\"template2\""));
    // Template / ContextDataFrom live in types/index.d.ts; emitter only augments the map
    assert.ok(!src.includes("export type Template ="));
    assert.ok(!src.includes("type ContextDataFrom"));
    assert.ok(!src.includes("TemplateEntry"));
    assert.ok(!src.includes("TemplateTab"));
  });

  it("should write .blaze-component-lsp/templates.d.ts on scan", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const registryPath = getRegistryPath(typedRoot);
    assert.ok(fs.existsSync(registryPath), `expected ${registryPath}`);
    const content = fs.readFileSync(registryPath, "utf-8");
    assert.ok(content.includes("template1"));
  });

  it("should include prop1 on template1 ContextData", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const src = generateRegistrySource(index);
    assert.match(src, /"template1":\s*\{[^}]*prop1:\s*number/);
  });
});

describe("spacebars type scope helpers", () => {
  it("should extract element types from array strings", () => {
    assert.equal(elementTypeFromArrayTypeString("Tab[]"), "Tab");
    assert.equal(elementTypeFromArrayTypeString("Array<Tab>"), "Tab");
    assert.equal(elementTypeFromArrayTypeString("(A | B)[]"), "A | B");
  });

  it("should detect template/data object shapes", () => {
    assert.equal(hasTemplateDataShape("{ template: T, data: U, name: string }"), true);
    assert.equal(hasTemplateDataShape("Tab"), true);
    assert.equal(hasTemplateDataShape("string"), false);
  });

  it("should classify Template name types", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    assert.equal(classifyTemplateNameType(index, "string"), "string");
    assert.equal(classifyTemplateNameType(index, "import(\"blaze-component-lsp\").Template"), "template");
    assert.equal(classifyTemplateNameType(index, "\"template1\""), "literal");
  });
});

describe("Template.dynamic diagnostics", () => {
  /** @type {ProjectIndex} */
  let index;

  it("indexes typed project", () => {
    index = new ProjectIndex(typedRoot);
    index.scan();
    // Re-index JS so helpers can see the freshly emitted blaze-component-lsp module
    for (const file of [
      "imports/ui/views/tabsPage/tabsPage.js",
      "imports/ui/components/template1/template1.js",
      "imports/ui/components/template2/template2.js"
    ]) {
      index.updateFile(path.join(typedRoot, file));
    }
    index.emitTemplateRegistry();
  });

  it("should accept correlated tab.template + tab.data inside each", () => {
    const html = `<template name="tabsPage">
  {{#each tab in tabs}}
    {{> Template.dynamic template=tab.template data=tab.data}}
  {{/each}}
</template>`;
    const diags = getDiagnostics(index, path.join(typedRoot, "tabs.html"), html, {
      errorOnTypeMismatch: true
    });
    const mismatch = diags.filter(d => d.message.includes("not assignable"));
    const missing = diags.filter(d => d.message.includes("is not defined"));
    assert.equal(mismatch.length, 0, mismatch.map(d => d.message).join("; "));
    assert.equal(missing.length, 0, missing.map(d => d.message).join("; "));
  });

  it("should error on unknown template string literal", () => {
    const html = `<template name="tabsPage">
  {{> Template.dynamic template="noSuchTemplate" data=x}}
</template>`;
    const diags = getDiagnostics(index, path.join(typedRoot, "tabs.html"), html, {
      errorOnTypeMismatch: true
    });
    assert.ok(
      diags.some(d => d.message.includes("noSuchTemplate") && d.message.includes("not defined")),
      diags.map(d => d.message).join("; ")
    );
  });

  it("should type-check data against ContextData for literal template name", () => {
    const html = `<template name="tabsPage">
  {{> Template.dynamic template="once" data="not-bool"}}
</template>`;
    const diags = getDiagnostics(index, path.join(typedRoot, "tabs.html"), html, {
      errorOnTypeMismatch: true
    });
    assert.ok(
      diags.some(d => d.message.includes("not assignable")),
      diags.map(d => d.message).join("; ")
    );
  });

  it("should allow matching literal data for once (boolean)", () => {
    const html = `<template name="tabsPage">
  {{> Template.dynamic template="once" data=true}}
</template>`;
    const diags = getDiagnostics(index, path.join(typedRoot, "tabs.html"), html, {
      errorOnTypeMismatch: true
    });
    assert.ok(
      !diags.some(d => d.message.includes("not assignable")),
      diags.map(d => d.message).join("; ")
    );
  });

  it("should require template argument on Template.dynamic", () => {
    const html = `<template name="tabsPage">
  {{> Template.dynamic data=true}}
</template>`;
    const diags = getDiagnostics(index, path.join(typedRoot, "tabs.html"), html, {
      errorOnTypeMismatch: true
    });
    assert.ok(
      diags.some(d => d.message.includes("requires a \"template\" argument")),
      diags.map(d => d.message).join("; ")
    );
  });
});
