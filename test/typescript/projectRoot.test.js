// @ts-check
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findMeteorRoot,
  findPackageRoot,
  findProjectRoot
} = require("../../server/utils/uri");

describe("findProjectRoot", () => {
  it("prefers package.js over enclosing .meteor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blaze-root-"));
    const app = path.join(tmp, "app");
    const pkg = path.join(app, "packages", "foo");
    fs.mkdirSync(path.join(app, ".meteor"), { recursive: true });
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.js"), "Package.describe({});\n");
    const file = path.join(pkg, "x.html");
    fs.writeFileSync(file, "<template name=\"x\"></template>\n");

    assert.equal(findMeteorRoot(file), app);
    assert.equal(findPackageRoot(file), pkg);
    assert.equal(findProjectRoot(file), pkg);
  });

  it("uses .meteor for app files outside any package.js", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blaze-app-"));
    const app = path.join(tmp, "app");
    fs.mkdirSync(path.join(app, ".meteor"), { recursive: true });
    fs.mkdirSync(path.join(app, "packages", "foo"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "packages", "foo", "package.js"),
      "Package.describe({});\n"
    );
    const file = path.join(app, "imports", "ui", "x.html");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<template name=\"x\"></template>\n");

    assert.equal(findMeteorRoot(file), app);
    assert.equal(findPackageRoot(file), null);
    assert.equal(findProjectRoot(file), app);
  });

  it("uses package.js when there is no .meteor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blaze-pkg-"));
    const pkg = path.join(tmp, "shared", "boards");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.js"), "Package.describe({});\n");
    const file = path.join(pkg, "src", "a.html");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<template name=\"a\"></template>\n");

    assert.equal(findMeteorRoot(file), null);
    assert.equal(findPackageRoot(file), pkg);
    assert.equal(findProjectRoot(file), pkg);
  });
});
