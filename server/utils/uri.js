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
 * Find the Meteor project root by looking for a .meteor directory.
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

module.exports = { uriToPath, pathToUri, findMeteorRoot };
