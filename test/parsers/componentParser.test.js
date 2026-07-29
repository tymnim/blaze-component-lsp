// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {
  parseComponent,
  findHTMLImports,
  findTypedefsFromJSDoc
} = require("../../server/parsers/componentParser");

const ts = require("typescript");
const fixturesDir = path.join(__dirname, "..", "fixtures");

function createSourceFile(source, name = "test.js") {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

describe("parseComponent — explicit registration", () => {
  it("should detect BlazeComponent.register(Template.X, Class)", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "colorPicker.js"), "utf-8");
    const components = parseComponent(source, "colorPicker.js");
    assert.equal(components.length, 1);
    assert.equal(components[0].templateName, "noteColorPicker");
    assert.equal(components[0].className, "ColorPicker");
  });
});

describe("parseComponent — decorator registration", () => {
  it("should detect @Component(Template.X) decorator", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    assert.equal(components.length, 1);
    assert.equal(components[0].templateName, "toggleButton");
    assert.equal(components[0].className, "toggleButton");
  });

  it("should detect @Component decorator in complex file", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "complex", "index.js"), "utf-8");
    const components = parseComponent(source, "index.js");
    assert.equal(components.length, 1);
    assert.equal(components[0].templateName, "index");
    assert.equal(components[0].className, "Index");
  });
});

describe("parseComponent — HelperMap extraction", () => {
  it("should extract helpers from static HelperMap returning array", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    const helperNames = components[0].helpers.map(h => h.name);
    assert.ok(helperNames.includes("isChecked"), "should find isChecked helper");
  });

  it("should extract multiple helpers from HelperMap", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "colorPicker.js"), "utf-8");
    const components = parseComponent(source, "colorPicker.js");
    const helperNames = components[0].helpers.map(h => h.name);
    assert.ok(helperNames.includes("colors"));
    assert.ok(helperNames.includes("currentColorCSS"));
  });

  it("should extract helpers from HelperMap returning object", () => {
    const source = `
      import { BlazeComponent } from "meteor/znewsham:blaze-component";
      class MyComp extends BlazeComponent {
        static HelperMap() {
          return { myHelper: "actualMethod" };
        }
        actualMethod() { return 42; }
      }
      BlazeComponent.register(Template.myTemplate, MyComp);
    `;
    const components = parseComponent(source, "test.js");
    assert.equal(components[0].helpers.length, 1);
    assert.equal(components[0].helpers[0].name, "myHelper");
    assert.equal(components[0].helpers[0].methodName, "actualMethod");
  });
});

describe("parseComponent — @Helper decorator extraction", () => {
  it("should extract @Helper decorated methods", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "complex", "index.js"), "utf-8");
    const components = parseComponent(source, "index.js");
    const helperNames = components[0].helpers.map(h => h.name);
    assert.ok(helperNames.includes("performingOfflineDownload"));
    assert.ok(helperNames.includes("text"));
    assert.ok(helperNames.includes("assignments"));
    assert.ok(helperNames.includes("allowed"));
    assert.ok(helperNames.includes("planeModeToggle"));
  });
});

describe("parseComponent — EventMap extraction", () => {
  it("should extract events from static EventMap", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    assert.equal(components[0].events.length, 1);
    assert.equal(components[0].events[0].selector, "click .toggle-button");
    assert.equal(components[0].events[0].methodName, "onchange");
  });

  it("should extract events from EventMap in colorPicker", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "colorPicker.js"), "utf-8");
    const components = parseComponent(source, "colorPicker.js");
    assert.equal(components[0].events.length, 1);
    assert.equal(components[0].events[0].selector, "click .color");
  });
});

describe("parseComponent — @Event decorator extraction", () => {
  it("should extract @Event decorated methods", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "complex", "index.js"), "utf-8");
    const components = parseComponent(source, "index.js");
    const selectors = components[0].events.map(e => e.selector);
    assert.ok(selectors.includes("click .dashboard-section-sort"));
    assert.ok(selectors.includes("click .titleDropdownContainer"));
  });
});

describe("parseComponent — HTML import detection", () => {
  it("should find HTML imports", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const sf = createSourceFile(source);
    const imports = findHTMLImports(sf);
    assert.ok(imports.includes("./toggle.html"));
  });

  it("should find HTML imports in component info", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    assert.equal(components[0].htmlImportPath, "./toggle.html");
  });
});

describe("parseComponent — context data extraction", () => {
  it("should extract @typedef ContextData fields", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    const fieldNames = components[0].contextDataFields.map(f => f.name);
    assert.ok(fieldNames.includes("html"), "should find html field");
    assert.ok(fieldNames.includes("text"), "should find text field");
    assert.ok(fieldNames.includes("icon"), "should find icon field");
    assert.ok(fieldNames.includes("target"), "should find target field");
    assert.ok(fieldNames.includes("checked"), "should find checked field");
    assert.ok(fieldNames.includes("onchange"), "should find onchange field");
  });

  it("should extract field types", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    const htmlField = components[0].contextDataFields.find(f => f.name === "html");
    assert.ok(htmlField);
    assert.equal(htmlField.type, "string");
  });

  it("should extract field descriptions", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    const htmlField = components[0].contextDataFields.find(f => f.name === "html");
    assert.ok(htmlField);
    assert.equal(htmlField.description, "HTML string");
  });
});

describe("parseComponent — parent class", () => {
  it("should detect parent class as null when extending BlazeComponent directly", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    assert.equal(components[0].parentClass, null);
  });

  it("should detect non-BlazeComponent parent class", () => {
    const source = `
      class MyComp extends SomeParent {
        static HelperMap() { return []; }
      }
      BlazeComponent.register(Template.myTpl, MyComp);
    `;
    const components = parseComponent(source, "test.js");
    assert.equal(components[0].parentClass, "SomeParent");
  });
});

describe("parseComponent — class range", () => {
  it("should have a valid class range", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    assert.ok(components[0].classRange);
    assert.ok(components[0].classRange.start.line >= 0);
    assert.ok(components[0].classRange.end.line > components[0].classRange.start.line);
  });
});

describe("parseComponent — helper ranges", () => {
  it("should point helper ranges to the method, not the HelperMap string", () => {
    const source = fs.readFileSync(path.join(fixturesDir, "simple", "toggle.js"), "utf-8");
    const components = parseComponent(source, "toggle.js");
    const isChecked = components[0].helpers.find(h => h.name === "isChecked");
    assert.ok(isChecked);
    assert.ok(isChecked.range.start.line > 0);
  });
});

describe("findTypedefsFromJSDoc", () => {
  it("should parse @typedef with @prop tags", () => {
    const source = `
/**
 * @typedef {Object} MyData
 * @prop {string} name - The name
 * @prop {number} count
 */
class X {}
    `;
    const sf = createSourceFile(source);
    const typedefs = findTypedefsFromJSDoc(sf, source);
    assert.ok(typedefs.has("MyData"));
    const fields = typedefs.get("MyData");
    assert.equal(fields.length, 2);
    assert.equal(fields[0].name, "name");
    assert.equal(fields[0].type, "string");
    assert.equal(fields[0].description, "The name");
    assert.equal(fields[1].name, "count");
    assert.equal(fields[1].type, "number");
  });
});

describe("parseComponent — no registration", () => {
  it("should return empty array for files without BlazeComponent registration", () => {
    const source = `export class NotAComponent { doStuff() {} }`;
    const components = parseComponent(source, "test.js");
    assert.equal(components.length, 0);
  });
});
