// @ts-check
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ProjectIndex } = require("../../server/indexer/projectIndex");
const {
  generateHelpersRegistrySource,
  getHelpersRegistryPath,
  emitHelpersRegistry
} = require("../../server/typescript/helpersRegistryEmitter");
const {
  getIndexCachePath,
  loadIndexCache,
  emitIndexCache,
  CACHE_VERSION
} = require("../../server/typescript/indexCache");

const typedRoot = path.join(__dirname, "..", "typed-project");

describe("helpers registry emitter", () => {
  it("should generate GlobalHelpers and TemplateHelpersMap", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const src = generateHelpersRegistrySource(index);
    assert.ok(src.includes("GlobalHelpers"));
    assert.ok(src.includes("TemplateHelpersMap"));
    assert.ok(src.includes("upper("), "should include global helper upper");
    assert.ok(src.includes("queryParamsWith("), "should include queryParamsWith");
    assert.ok(src.includes("\"toggleButton\""), "should include template helpers map entry");
    assert.ok(src.includes("isChecked("), "should include component helper");
  });

  it("should write helpers.d.ts on scan", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const helpersPath = getHelpersRegistryPath(typedRoot);
    assert.ok(fs.existsSync(helpersPath), `expected ${helpersPath}`);
    const content = fs.readFileSync(helpersPath, "utf-8");
    assert.ok(content.includes("GlobalHelpers"));
  });
});

describe("index-cache hydrate + boot", () => {
  it("should write index-cache.json on scan", () => {
    const index = new ProjectIndex(typedRoot);
    index.scan();
    const cachePath = getIndexCachePath(typedRoot);
    assert.ok(fs.existsSync(cachePath), `expected ${cachePath}`);
    const cache = loadIndexCache(typedRoot);
    assert.ok(cache);
    assert.equal(cache.version, CACHE_VERSION);
    assert.ok(cache.templates.some(t => t.name === "toggleButton"));
    assert.ok(cache.globalHelpers.some(g => g.name === "upper"));
    assert.ok(cache.globalHelpers.some(g => g.name === "queryParamsWith"));
    const q = cache.globalHelpers.find(g => g.name === "queryParamsWith");
    assert.ok(q.documentation && q.documentation.includes("Reactively"));
  });

  it("should hydrate from cache without TypeService ready", () => {
    // Ensure cache exists
    const seed = new ProjectIndex(typedRoot);
    seed.scan();

    const index = new ProjectIndex(typedRoot);
    assert.equal(index.typeService.isReady, false, "TypeService should be lazy");

    const cache = loadIndexCache(typedRoot);
    assert.ok(cache);
    const { hydrateFromCache } = require("../../server/typescript/indexCache");
    hydrateFromCache(index, cache);

    assert.equal(index.typeService.isReady, false, "hydrate must not create LanguageService");
    const upper = index.getGlobalHelper("upper");
    assert.ok(upper, "hydrated global helper");
    assert.ok(upper.documentation && upper.documentation.toLowerCase().includes("uppercase"));

    const toggle = index.getComponentForTemplate("toggleButton");
    assert.ok(toggle, "hydrated component");
    assert.ok(toggle.helpers.some(h => h.name === "isChecked"));
  });

  it("boot hydrates then background scan refreshes", async () => {
    const seed = new ProjectIndex(typedRoot);
    seed.scan();

    const index = new ProjectIndex(typedRoot);
    /** @type {Promise<void>} */
    const done = new Promise((resolve) => {
      index.boot({
        onScanComplete: () => resolve()
      });
    });

    assert.ok(index.hydratedFromCache || index.ready);
    assert.ok(index.getGlobalHelper("upper") || index.scanning);

    await done;

    assert.equal(index.scanning, false);
    assert.ok(index.typeService.isReady, "background scan should ready TypeService");
    assert.ok(index.getGlobalHelper("queryParamsWith"));
    assert.ok(fs.existsSync(getHelpersRegistryPath(typedRoot)));
    assert.ok(fs.existsSync(getIndexCachePath(typedRoot)));
  });

  it("background scan overwrites stale cache entry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blaze-cache-"));
    try {
      const meteorDir = path.join(tmp, ".meteor");
      fs.mkdirSync(meteorDir);
      fs.writeFileSync(path.join(meteorDir, "release"), "METEOR@3.0\n");

      const cacheDir = path.join(tmp, ".blaze-component-lsp");
      fs.mkdirSync(cacheDir);
      fs.writeFileSync(
        path.join(cacheDir, "index-cache.json"),
        JSON.stringify({
          version: CACHE_VERSION,
          rootPath: tmp,
          generatedAt: new Date().toISOString(),
          templates: [{
            name: "staleTpl",
            filePath: "/x.html",
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
            isBlockTemplate: false,
            includedTemplates: []
          }],
          components: [],
          globalHelpers: [{
            name: "staleHelper",
            filePath: "/x.js",
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
            returnType: "string",
            documentation: "stale"
          }]
        }, null, 2)
      );

      fs.writeFileSync(
        path.join(tmp, "app.html"),
        '<template name="liveTpl">\n  {{ok}}\n</template>\n'
      );
      fs.writeFileSync(
        path.join(tmp, "app.js"),
        `import { Blaze } from "meteor/blaze";
Blaze.registerHelper("liveHelper", /** @returns {number} */ function () { return 1; });
`
      );

      const index = new ProjectIndex(tmp);
      const finished = new Promise((resolve) => {
        index.boot({ onScanComplete: () => resolve(undefined) });
      });

      assert.ok(index.hydratedFromCache);
      assert.ok(index.getGlobalHelper("staleHelper"), "stale helper from cache");

      await finished;

      assert.ok(index.getTemplate("liveTpl"), "live template after scan");
      assert.ok(index.getGlobalHelper("liveHelper"), "live helper after scan");
      assert.equal(index.getGlobalHelper("staleHelper"), undefined, "stale helper cleared");

      const cache = loadIndexCache(tmp);
      assert.ok(cache);
      assert.ok(cache.globalHelpers.some(g => g.name === "liveHelper"));
      assert.ok(!cache.globalHelpers.some(g => g.name === "staleHelper"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
