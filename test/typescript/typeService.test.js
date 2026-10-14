// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { TypeService } = require("../../server/typescript/typeService");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const { getDiagnostics } = require("../../server/providers/diagnosticProvider");

const typedRoot = path.join(__dirname, "..", "typed-project");

describe("TypeService — assignability", () => {
  it("should treat identical types as assignable", () => {
    const ts = new TypeService(typedRoot);
    assert.equal(ts.isAssignableByString("string", "string"), true);
  });

  it("should allow string assignable to string | undefined", () => {
    const ts = new TypeService(typedRoot);
    assert.equal(ts.isAssignableByString("string", "string | undefined"), true);
  });

  it("should reject number assignable to string", () => {
    const ts = new TypeService(typedRoot);
    assert.equal(ts.isAssignableByString("number", "string"), false);
  });

  it("should allow any expected type", () => {
    const ts = new TypeService(typedRoot);
    assert.equal(ts.isAssignableByString("number", "any"), true);
  });
});

describe("TypeService — ContextData via checker", () => {
  it("should resolve @typedef ContextData fields", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const comp = index.getComponentForTemplate("toggleButton");
    assert.ok(comp, "toggleButton component");
    const names = comp.contextDataFields.map(f => f.name);
    assert.ok(names.includes("text"), `expected text in ${names.join(",")}`);
    assert.ok(names.includes("checked"), `expected checked in ${names.join(",")}`);
    assert.ok(names.includes("isDisabled"), `expected isDisabled in ${names.join(",")}`);

    const text = comp.contextDataFields.find(f => f.name === "text");
    assert.ok(text && text.type.includes("string"), `text type was ${text && text.type}`);
  });

  it("should resolve primitive ContextData as synthetic data field", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const comp = index.getComponentForTemplate("once");
    assert.ok(comp);
    assert.equal(comp.contextDataFields.length, 1);
    assert.equal(comp.contextDataFields[0].name, "data");
    assert.ok(
      comp.contextDataFields[0].type.includes("boolean"),
      `got ${comp.contextDataFields[0].type}`
    );
  });

  it("should resolve inline object ContextData", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const comp = index.getComponentForTemplate("inlineCard");
    assert.ok(comp);
    const names = comp.contextDataFields.map(f => f.name);
    assert.ok(names.includes("title"), `got ${names.join(",")}`);
    assert.ok(names.includes("count"), `got ${names.join(",")}`);
  });
});

describe("TypeService — helper signatures", () => {
  it("should resolve helper return types from JSDoc / checker", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const comp = index.getComponentForTemplate("toggleButton");
    assert.ok(comp);
    const isChecked = comp.helpers.find(h => h.name === "isChecked");
    assert.ok(isChecked);
    assert.ok(
      isChecked.returnType && isChecked.returnType.includes("string"),
      `isChecked.returnType=${isChecked.returnType}`
    );

    const label = comp.helpers.find(h => h.name === "label");
    assert.ok(label);
    assert.ok(label.returnType && label.returnType.includes("string"));
    assert.ok(label.params && label.params.length >= 1);
    assert.equal(label.params[0].name, "n");
    assert.ok(label.params[0].type && label.params[0].type.includes("number"));
  });

  it("should resolve global helper signatures", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const upper = index.getGlobalHelper("upper");
    assert.ok(upper, "global helper upper");
    assert.ok(upper.returnType && upper.returnType.includes("string"), `return=${upper.returnType}`);
    assert.ok(upper.params && upper.params.length >= 1);
    assert.equal(upper.params[0].name, "value");
  });
});

describe("TypeService — diagnostics assignability", () => {
  it("should flag type mismatch using checker assignability", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();

    const html = `
<template name="page">
  {{> once "not-a-boolean"}}
</template>
`;
    // Register a fake page template component so diagnostics run type checks
    // once expects boolean (single data field)
    const diagnostics = getDiagnostics(index, path.join(typedRoot, "page.html"), html, {
      errorOnTypeMismatch: true
    });

    // Template "page" has no component — diagnostics skip type checks for host.
    // Use toggleButton as host instead (has component).
    const html2 = `
<template name="toggleButton">
  {{> once "not-a-boolean"}}
</template>
`;
    const diags = getDiagnostics(
      index,
      path.join(typedRoot, "imports/ui/components/toggle/toggle.html"),
      html2,
      { errorOnTypeMismatch: true }
    );
    const mismatch = diags.find(d => d.message.includes("not assignable"));
    assert.ok(mismatch, `expected mismatch diagnostic, got: ${diags.map(d => d.message).join("; ")}`);
  });

  it("should allow compatible literal types", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const html = `
<template name="toggleButton">
  {{> once true}}
</template>
`;
    const diags = getDiagnostics(
      index,
      path.join(typedRoot, "imports/ui/components/toggle/toggle.html"),
      html,
      { errorOnTypeMismatch: true }
    );
    const mismatch = diags.find(d => d.message.includes("not assignable"));
    assert.equal(mismatch, undefined, mismatch && mismatch.message);
  });

  it("should flag positional multi-field ContextData mismatch", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    // isChecked returns string; template1 expects { prop1: number }
    const html = `
<template name="toggleButton">
  {{> template1 isChecked}}
</template>
`;
    const diags = getDiagnostics(
      index,
      path.join(typedRoot, "imports/ui/components/toggle/toggle.html"),
      html,
      { errorOnTypeMismatch: true }
    );
    const mismatch = diags.find(d => d.message.includes("not assignable"));
    assert.ok(
      mismatch,
      `expected mismatch for {{> template1 isChecked}}, got: ${diags.map(d => d.message).join("; ")}`
    );
  });

  it("should accept positional helper matching multi-field ContextData", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();

    const togglePath = path.join(typedRoot, "imports/ui/components/toggle/toggle.js");
    index.updateFile(
      togglePath,
      `import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";
import "./toggle.html";

/**
 * @typedef {Object} ContextData
 * @prop {string} text
 * @prop {boolean} checked
 * @prop {boolean} [isDisabled]
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.toggleButton)
export class toggleButton extends BlazeComponent {
  static HelperMap() {
    return ["isChecked", "label", "template1Data"];
  }

  /** @returns {string} */
  isChecked() {
    return "checked";
  }

  /**
   * @param {number} n
   * @returns {string}
   */
  label(n) {
    return \`\${n}\`;
  }

  /**
   * @returns {{ prop1: number }}
   */
  template1Data() {
    return { prop1: 1 };
  }
}

BlazeComponent.register(Template.toggleButton, toggleButton);
`
    );

    const html = `
<template name="toggleButton">
  {{> template1 template1Data}}
</template>
`;
    const diags = getDiagnostics(
      index,
      path.join(typedRoot, "imports/ui/components/toggle/toggle.html"),
      html,
      { errorOnTypeMismatch: true }
    );
    const mismatch = diags.find(d => d.message.includes("not assignable"));
    assert.equal(
      mismatch,
      undefined,
      mismatch && mismatch.message
    );
  });
});

describe("TypeService — fallback without strong types", () => {
  it("should still index components when BlazeComponent types are missing", () => {
    const simpleRoot = path.join(__dirname, "..", "fixtures", "simple");
    const index = new ProjectIndex(simpleRoot);
    index.scan();
    const comp = index.getComponentForTemplate("toggleButton");
    assert.ok(comp);
    // JSDoc fallback should still provide context fields
    assert.ok(comp.contextDataFields.length > 0);
    assert.ok(comp.contextDataFields.some(f => f.name === "text"));
  });
});
