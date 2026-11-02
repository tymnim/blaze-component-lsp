// @ts-check
const path = require("node:path");
const url = require("node:url");

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
 * @returns {string|null}
 */
function findMeteorRoot(startPath) {
  const fs = require("node:fs");
  let dir = path.isAbsolute(startPath)
    ? (fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath))
    : startPath;

  while (dir !== path.dirname(dir)) {
    const meteorDir = path.join(dir, ".meteor");
    try {
      if (fs.statSync(meteorDir).isDirectory()) {
        return dir;
      }
    } catch {}
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Find a Meteor package root (directory containing package.js).
 * Prefers the nearest package.js when walking up; stops at filesystem root.
 * @param {string} startPath
 * @returns {string|null}
 */
function findPackageRoot(startPath) {
  const fs = require("node:fs");
  let dir = path.isAbsolute(startPath)
    ? (fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath))
    : startPath;

  while (dir !== path.dirname(dir)) {
    try {
      if (fs.statSync(path.join(dir, "package.js")).isFile()) {
        return dir;
      }
    } catch {}
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
 * @returns {string|null}
 */
function findProjectRoot(startPath) {
  return findPackageRoot(startPath) || findMeteorRoot(startPath);
}

module.exports = {
  uriToPath,
  pathToUri,
  findMeteorRoot,
  findPackageRoot,
  findProjectRoot
};
