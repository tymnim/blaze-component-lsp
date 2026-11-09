// @ts-check
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createScriptRunner, readScripts, findConfigRoots } = require("../../server/scripts/scriptRunner");

const wait = (/** @type {() => boolean} */ cond) => new Promise((resolve, reject) => {
  const start = Date.now();
  const t = setInterval(() => {
    if (cond()) { clearInterval(t); resolve(undefined); }
    else if (Date.now() - start > 5000) { clearInterval(t); reject(new Error("timeout")); }
  }, 20);
});

describe("scriptRunner", () => {
  /** @type {string[]} */
  const dirs = [];
  /** @type {ReturnType<typeof createScriptRunner>|null} */
  let runner = null;
  afterEach(() => {
    runner?.stopAll();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blaze-scripts-")));
    dirs.push(d);
    return d;
  };

  it("runs commands in the config directory, once, and stops removed ones", async () => {
    const root = tmp();
    /** @type {string[]} */
    const logs = [];
    runner = createScriptRunner((m) => logs.push(m));
    const cmd = "pwd && sleep 30";
    runner.sync(root, [cmd]);
    runner.sync(root, [cmd]);
    await wait(() => logs.includes(`[script:${cmd}] ${root}`));
    assert.equal(logs.filter((l) => l.endsWith("started in " + root)).length, 1);
    assert.deepEqual(runner.commandsFor(root), [cmd]);

    runner.sync(root, []);
    await wait(() => logs.some((l) => l.includes("exited")));
    assert.deepEqual(runner.commandsFor(root), []);
  });

  it("reads and validates scripts, and finds nested configs", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "blaze-component-config.json"), JSON.stringify({ scripts: ["x", 3, " "] }));
    fs.writeFileSync(path.join(root, "node_modules", "blaze-component-config.json"), "{}");
    fs.writeFileSync(path.join(root, "a", "blaze-component-config.json"), "not json");
    assert.deepEqual(readScripts(path.join(root, "blaze-component-config.json")), ["x"]);
    assert.deepEqual(readScripts(path.join(root, "a", "blaze-component-config.json")), []);
    assert.deepEqual(findConfigRoots(root).sort(), [root, path.join(root, "a")].sort());
  });
});
