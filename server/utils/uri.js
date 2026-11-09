// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const { isWithin } = require("./boundary");

/**
 * Convert a file URI to a file path.
 * @param {string} uri
 * @returns {string}
 */
function uriToPath(uri) {
  if (uri.startsWith("file://")) {
    return url.fileURLToPath(uri);
  }
  return uri;
}

/**
 * Convert a file path to a file URI.
 * @param {string} filePath
 * @returns {string}
 */
function pathToUri(filePath) {
  return url.pathToFileURL(filePath).toString();
}

/**
 * Find the Meteor app root by looking for a .meteor directory.
 * @param {string} startPath - A file or directory path
 * @param {string} [stopDir] - Never look above this directory (inclusive); null if startPath is outside it
 * @returns {string|null}
 */
function findMeteorRoot(startPath, stopDir) {
  let dir = path.isAbsolute(startPath)
    ? (fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath))
    : startPath;

  if (stopDir && !isWithin(dir, stopDir)) return null;
  while (dir !== path.dirname(dir)) {
    const meteorDir = path.join(dir, ".meteor");
    try {
      if (fs.statSync(meteorDir).isDirectory()) {
        return dir;
      }
    } catch {}
    if (dir === stopDir) break;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Find a Meteor package root (directory containing package.js).
 * Prefers the nearest package.js when walking up; stops at filesystem root.
 * @param {string} startPath
 * @param {string} [stopDir] - Never look above this directory (inclusive)
 * @returns {string|null}
 */
function findPackageRoot(startPath, stopDir) {
  let dir = path.isAbsolute(startPath)
    ? (fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath))
    : startPath;

  if (stopDir && !isWithin(dir, stopDir)) return null;
  while (dir !== path.dirname(dir)) {
    try {
      if (fs.statSync(path.join(dir, "package.js")).isFile()) {
        return dir;
      }
    } catch {}
    if (dir === stopDir) break;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Index root for blaze-component-lsp: nearest package.js wins over an enclosing
 * .meteor so local / shared packages get their own index and
 * `.blaze-component-lsp/` registry (TemplateContextMap stays package-local).
 * App files outside any package still use the .meteor root.
 * @param {string} startPath
 * @param {string} [stopDir] - Never look above this directory (inclusive)
 * @returns {string|null}
 */
function findProjectRoot(startPath, stopDir) {
  return findPackageRoot(startPath, stopDir) || findMeteorRoot(startPath, stopDir);
}



/**
 * Nearest blaze-component-config.json at or above `startDir` (supports monorepo-root configs).
 * @param {string} startDir
 * @param {string} [stopDir] - Never look above this directory (inclusive)
 * @returns {string|null}
 */
function findConfigFile(startDir, stopDir) {
  let dir = startDir;
  if (stopDir && !isWithin(dir, stopDir)) return null;
  while (true) {
    const candidate = path.join(dir, "blaze-component-config.json");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
    const parent = path.dirname(dir);
    if (dir === stopDir || parent === dir) return null;
    dir = parent;
  }
}

module.exports = {
  findConfigFile,
  uriToPath,
  pathToUri,
  findMeteorRoot,
  findPackageRoot,
  findProjectRoot
};
