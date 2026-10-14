// @ts-check
const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {import("../indexer/projectIndex").ProjectIndex} ProjectIndex
 * @typedef {import("../parsers/componentParser").ComponentInfo} ComponentInfo
 * @typedef {import("../parsers/componentParser").HelperInfo} HelperInfo
 * @typedef {import("../parsers/componentParser").ContextField} ContextField
 * @typedef {import("../parsers/componentParser").GlobalHelperInfo} GlobalHelperInfo
 * @typedef {import("../parsers/componentParser").EventInfo} EventInfo
 * @typedef {import("../parsers/spacebarsParser").TemplateBlock} TemplateBlock
 * @typedef {import("../parsers/spacebarsParser").SourceRange} SourceRange
 */

const REGISTRY_DIR = ".blaze-component-lsp";
const CACHE_FILE = "index-cache.json";
const CACHE_VERSION = 1;

/**
 * @param {string} rootPath
 * @returns {string}
 */
function getIndexCachePath(rootPath) {
  return path.join(rootPath, REGISTRY_DIR, CACHE_FILE);
}

/**
 * @typedef {Object} IndexCachePayload
 * @prop {number} version
 * @prop {string} rootPath
 * @prop {string} generatedAt
 * @prop {object[]} templates
 * @prop {object[]} components
 * @prop {object[]} globalHelpers
 */

/**
 * Serialize the in-memory index for fast cold start.
 * @param {ProjectIndex} index
 * @returns {IndexCachePayload}
 */
function serializeIndexCache(index) {
  /** @type {object[]} */
  const templates = [];
  for (const [name, tpl] of index.templateIndexer.templates) {
    templates.push({
      name,
      filePath: tpl.filePath || "",
      range: tpl.range,
      isBlockTemplate: !!tpl.isBlockTemplate,
      includedTemplates: tpl.includedTemplates || []
    });
  }

  /** @type {object[]} */
  const components = [];
  for (const comp of index.componentIndexer.components.values()) {
    components.push({
      className: comp.className,
      filePath: comp.filePath,
      templateName: comp.templateName,
      helpers: comp.helpers,
      events: comp.events || [],
      contextDataFields: comp.contextDataFields,
      parentClass: comp.parentClass,
      htmlImportPath: comp.htmlImportPath,
      classRange: comp.classRange
    });
  }

  /** @type {object[]} */
  const globalHelpers = Array.from(index.componentIndexer.globalHelpers.values());

  return {
    version: CACHE_VERSION,
    rootPath: index.rootPath,
    generatedAt: new Date().toISOString(),
    templates,
    components,
    globalHelpers
  };
}

/**
 * Write index-cache.json (always overwrite — caller decides when).
 * @param {ProjectIndex} index
 * @returns {{ path: string, written: boolean }}
 */
function emitIndexCache(index) {
  const outPath = getIndexCachePath(index.rootPath);
  const payload = serializeIndexCache(index);
  const content = JSON.stringify(payload, null, 2);

  let existing = "";
  try {
    existing = fs.readFileSync(outPath, "utf-8");
  } catch {
    // missing
  }

  if (existing === content) {
    return { path: outPath, written: false };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, "utf-8");
  return { path: outPath, written: true };
}

/**
 * Load and validate cache from disk.
 * @param {string} rootPath
 * @returns {IndexCachePayload|null}
 */
function loadIndexCache(rootPath) {
  const cachePath = getIndexCachePath(rootPath);
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (parsed.rootPath && path.resolve(parsed.rootPath) !== path.resolve(rootPath)) {
      // Allow relative moves within same folder name; still accept if paths differ
      // only when version matches — root may be remounted.
    }
    if (!Array.isArray(parsed.templates) || !Array.isArray(parsed.components) || !Array.isArray(parsed.globalHelpers)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Hydrate indexers from a cache payload (no disk scan / no TypeService).
 * @param {ProjectIndex} index
 * @param {IndexCachePayload} cache
 */
function hydrateFromCache(index, cache) {
  index.templateIndexer.hydrateFromCache(cache.templates);
  index.componentIndexer.hydrateFromCache(cache.components, cache.globalHelpers);

  for (const tpl of cache.templates) {
    if (tpl.filePath) index._indexedFiles.add(tpl.filePath);
  }
  for (const comp of cache.components) {
    if (comp.filePath) index._indexedFiles.add(comp.filePath);
  }
  for (const g of cache.globalHelpers) {
    if (g.filePath) index._indexedFiles.add(g.filePath);
  }
}

module.exports = {
  CACHE_FILE,
  CACHE_VERSION,
  getIndexCachePath,
  serializeIndexCache,
  emitIndexCache,
  loadIndexCache,
  hydrateFromCache
};
