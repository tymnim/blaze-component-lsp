// @ts-check
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findProjectRoot, findConfigFile } = require("../../server/utils/uri");
const { createBoundary } = require("../../server/utils/boundary");
const { ProjectIndex } = require("../../server/indexer/projectIndex");

const CLI = path.join(__dirname, "..", "..", "cli", "index.js");

/**
 * outer/                      <- NOT part of the project
 *   .meteor/, package.js, blaze-component-config.json (errorOnMissingComponent)
 *   outsideDir/outside.html   <- template "outsideSecret"
 *   outside.html
 *   inner/                    <- the "monorepo" the tools are run from
 *     pkg/package.js, pkg/inside.html  <- template "insideTemplate"
 *     pkg/linkToOutside -> ../../outsideDir
 *     linkToOutsideFile.html -> ../outside.html
 *     linkInside -> pkg   (allowed: stays inside)
 */
describe("project boundary", () => {
  /** @type {string} */ let outer;
  /** @type {string} */ let inner;
  /** @type {string} */ let pkg;

  before(() => {
    outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blaze-boundary-")));
    inner = path.join(outer, "inner");
    pkg = path.join(inner, "pkg");
    fs.mkdirSync(path.join(outer, ".meteor"));
    fs.mkdirSync(path.join(outer, "outsideDir"));
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(outer, "package.js"), "");
    fs.writeFileSync(path.join(outer, "blaze-component-config.json"), JSON.stringify({ errorOnMissingComponent: true }));
    fs.writeFileSync(path.join(outer, "outsideDir", "outside.html"), '<template name="outsideSecret"><p>x</p></template>');
    fs.writeFileSync(path.join(outer, "outside.html"), '<template name="outsideFileSecret"><p>x</p></template>');
    fs.writeFileSync(path.join(pkg, "package.js"), "");
    fs.writeFileSync(path.join(pkg, "inside.html"), '<template name="insideTemplate"><p>x</p></template>');
    fs.symlinkSync(path.join(outer, "outsideDir"), path.join(pkg, "linkToOutside"));
    fs.symlinkSync(path.join(outer, "outside.html"), path.join(pkg, "linkToOutsideFile.html"));
    fs.symlinkSync(pkg, path.join(inner, "linkInside"));
  });

  after(() => fs.rmSync(outer, { recursive: true, force: true }));

  it("root and config lookup never climb above the stop directory", () => {
    const bare = path.join(inner, "bare");
    fs.mkdirSync(bare, { recursive: true });
    assert.equal(findProjectRoot(bare), outer, "control: unbounded lookup escapes");
    assert.equal(findProjectRoot(bare, inner), null);
    assert.equal(findConfigFile(bare), path.join(outer, "blaze-component-config.json"), "control");
    assert.equal(findConfigFile(bare, inner), null);
    assert.equal(findProjectRoot(outer, inner), null, "start outside the bound");
    assert.equal(findProjectRoot(pkg, inner), pkg);
  });

  it("boundary resolves symlinks before checking containment", () => {
    const b = createBoundary([inner]);
    assert.equal(b.contains(path.join(pkg, "inside.html")), true);
    assert.equal(b.contains(path.join(pkg, "linkToOutside")), false);
    assert.equal(b.contains(path.join(pkg, "linkToOutsideFile.html")), false);
    assert.equal(b.contains(path.join(inner, "linkInside")), true);
    assert.equal(b.contains(path.join(inner, "..", "outside.html")), false);
  });

  it("ProjectIndex does not follow symlinks out of the boundary", () => {
    const open = new ProjectIndex(pkg);
    open.scan();
    assert.ok(open.getTemplate("outsideSecret"), "control: unbounded index follows the symlink");

    const bounded = new ProjectIndex(pkg, { boundaryDirs: [inner] });
    bounded.scan();
    assert.ok(bounded.getTemplate("insideTemplate"));
    assert.equal(bounded.getTemplate("outsideSecret"), undefined);
    assert.equal(bounded.getTemplate("outsideFileSecret"), undefined);
  });

  it("blaze-check run from inside never reports, indexes or configures from outside", () => {
    const res = spawnSync(process.execPath, [CLI, "."], { cwd: inner, encoding: "utf-8" });
    const out = res.stdout + res.stderr;
    assert.match(out, /insideTemplate/);
    assert.doesNotMatch(out, /outside/i);
    assert.doesNotMatch(out, new RegExp(outer.replace(/[/\\]/g, "[/\\\\]") + "(?!/inner)(?![/\\\\]inner)[^\\s]*"), "no path above cwd");
    // outer config (errorOnMissingComponent) must not apply → info, exit 0
    assert.equal(res.status, 0, out);
    assert.match(out, /info/);
  });

  it("blaze-check refuses a symlink target that resolves outside cwd", () => {
    const res = spawnSync(process.execPath, [CLI, "pkg/linkToOutside"], { cwd: inner, encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /outside the current directory/);
  });

  it("blaze-check finds no project when none exists at/below cwd (does not use the outer one)", () => {
    const bare = path.join(inner, "bare");
    fs.writeFileSync(path.join(bare, "x.html"), '<template name="bareT"><p/></template>');
    const res = spawnSync(process.execPath, [CLI, "."], { cwd: bare, encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No Meteor app/);
  });
});
