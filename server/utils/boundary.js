// @ts-check
const fs = require("node:fs");
const path = require("node:path");

/** @param {string} p */
function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * @param {string} p
 * @param {string} dir
 */
function isWithin(p, dir) {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Filesystem boundary: a path is contained only if its *real* path (symlinks resolved)
 * is inside one of the boundary directories.
 * @param {string[]} dirs
 */
function createBoundary(dirs) {
  const roots = dirs.map(realOrResolved);
  return {
    dirs,
    /** @param {string} p */
    contains(p) {
      const real = realOrResolved(p);
      return roots.some((r) => isWithin(real, r));
    }
  };
}

module.exports = { createBoundary, isWithin };
