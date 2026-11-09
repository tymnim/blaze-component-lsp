// @ts-check
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_NAME = "blaze-component-config.json";
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".blaze-component-lsp", ".meteor"]);

/**
 * Manages long-lived shell scripts declared in blaze-component-config.json.
 * @param {(msg: string) => void} [log]
 */
function createScriptRunner(log = () => {}) {
  /** @type {Map<string, Map<string, import("node:child_process").ChildProcess>>} root → command → child */
  const running = new Map();

  /** @param {import("node:child_process").ChildProcess} child */
  function kill(child) {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  /**
   * @param {string} root
   * @param {string} command
   */
  function startOne(root, command) {
    const tag = `[script:${command}]`;
    const child = spawn(command, { cwd: root, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    /** @param {Buffer} data */
    const pipe = (data) => {
      for (const line of data.toString().split(/\r?\n/)) {
        if (line.trim()) log(`${tag} ${line}`);
      }
    };
    child.stdout?.on("data", pipe);
    child.stderr?.on("data", pipe);
    child.on("error", (err) => log(`${tag} failed to start: ${err.message}`));
    child.on("exit", (code, signal) => {
      log(`${tag} exited (${signal ?? code})`);
      const map = running.get(root);
      if (map && map.get(command) === child) map.delete(command);
    });
    log(`${tag} started in ${root}`);
    return child;
  }

  return {
    /**
     * Make the running scripts for `root` match `commands`.
     * @param {string} root
     * @param {string[]} commands
     */
    sync(root, commands) {
      const wanted = new Set(commands);
      let map = running.get(root);
      if (!map) running.set(root, (map = new Map()));
      for (const [command, child] of map) {
        if (!wanted.has(command)) {
          kill(child);
          map.delete(command);
        }
      }
      for (const command of wanted) {
        if (!map.has(command)) map.set(command, startOne(root, command));
      }
      if (map.size === 0) running.delete(root);
    },

    stopAll() {
      for (const map of running.values()) for (const child of map.values()) kill(child);
      running.clear();
    },

    /** @param {string} root @returns {string[]} */
    commandsFor(root) {
      return [...(running.get(root)?.keys() ?? [])];
    }
  };
}

/**
 * Read the validated `scripts` array from a config file.
 * @param {string} configPath
 * @returns {string[]}
 */
function readScripts(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!Array.isArray(parsed.scripts)) return [];
    return parsed.scripts.filter((/** @type {unknown} */ s) => typeof s === "string" && s.trim());
  } catch {
    return [];
  }
}

/**
 * Find directories containing blaze-component-config.json under `dir`.
 * @param {string} dir
 * @param {number} [depth]
 * @returns {string[]}
 */
function findConfigRoots(dir, depth = 4) {
  /** @type {string[]} */
  const roots = [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return roots;
  }
  if (entries.some((e) => e.isFile() && e.name === CONFIG_NAME)) roots.push(dir);
  if (depth <= 0) return roots;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
      roots.push(...findConfigRoots(path.join(dir, e.name), depth - 1));
    }
  }
  return roots;
}

module.exports = { createScriptRunner, readScripts, findConfigRoots, CONFIG_NAME };
