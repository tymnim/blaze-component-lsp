#!/usr/bin/env node
// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { ProjectIndex } = require("../server/indexer/projectIndex");
const { getDiagnostics } = require("../server/providers/diagnosticProvider");
const { findProjectRoot, findConfigFile } = require("../server/utils/uri");
const { createBoundary, isWithin } = require("../server/utils/boundary");
const {
  setFileTraceEnabled,
  isFileTraceEnabled,
  traceFiles
} = require("../server/typescript/typeService");

const SEVERITY_LABELS = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const SEVERITY_COLORS = { 1: "\x1b[31m", 2: "\x1b[33m", 3: "\x1b[36m", 4: "\x1b[90m" };
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function printUsage() {
  console.log(`
${BOLD}blaze-check${RESET} — type-check Blaze/Spacebars HTML templates

${BOLD}Usage:${RESET}
  blaze-check [options] [file|folder...]

${BOLD}Options:${RESET}
  --error-on-type-mismatch  Treat type mismatches as errors (exit code 1)
  --quiet                   Only show errors, suppress warnings/info
  --no-color                Disable colored output
  --json                    Output diagnostics as JSON
  --trace-files             Log every file the TypeService opens (stderr; also BLAZE_COMPONENT_LSP_TRACE_FILES=1)
  -h, --help                Show this help

${BOLD}Examples:${RESET}
  blaze-check .                          Check all HTML files under current directory
  blaze-check imports/ui/               Check a specific folder
  blaze-check imports/ui/views/index.html  Check a single file
  blaze-check --trace-files services/recruit/app 2>trace.log
  npx blaze-check .                     Run via npx
`);
}

function main() {
  const args = process.argv.slice(2);

  let errorOnTypeMismatch = false;
  let quiet = false;
  let useColor = process.stdout.isTTY !== false;
  let jsonOutput = false;
  /** @type {string[]} */
  const targets = [];

  for (const arg of args) {
    switch (arg) {
      case "--error-on-type-mismatch": errorOnTypeMismatch = true; break;
      case "--quiet": quiet = true; break;
      case "--no-color": useColor = false; break;
      case "--json": jsonOutput = true; break;
      case "--trace-files": setFileTraceEnabled(true); break;
      case "-h": case "--help": printUsage(); process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          printUsage();
          process.exit(1);
        }
        targets.push(arg);
    }
  }

  if (targets.length === 0) targets.push(".");

  for (const target of targets) {
    if (!fs.existsSync(path.resolve(target))) {
      console.error(`Path not found: ${target}`);
      process.exit(1);
    }
  }

  const cwd = process.cwd();
  const targetDirs = targets.map((t) => {
    const resolved = path.resolve(t);
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  });
  // Nothing is indexed, read or followed (symlinks included) outside the cwd, or, for
  // targets outside it, outside the target itself.
  const boundaryDirs = [cwd, ...targetDirs.filter((d) => !isWithin(d, cwd))];
  const boundary = createBoundary(boundaryDirs);
  /** @param {string} p */
  const boundDirFor = (p) => isWithin(p, cwd) ? cwd : targetDirs.find((d) => isWithin(p, d));
  /**
   * @param {string} p
   * @returns {string|null}
   */
  const projectRootFor = (p) => {
    const dir = boundDirFor(p);
    return dir ? findProjectRoot(p, dir) : null;
  };

  /** @type {string[]} */
  const htmlFiles = [];
  for (const target of targets) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      console.error(`Path not found: ${target}`);
      process.exit(1);
    }
    if (!boundary.contains(resolved)) {
      console.error(`Refusing ${target}: it resolves outside the current directory.`);
      process.exit(1);
    }
    if (fs.statSync(resolved).isFile()) {
      if (resolved.endsWith(".html")) htmlFiles.push(resolved);
      else console.error(`Skipping non-HTML file: ${target}`);
    } else {
      collectHtmlFiles(resolved, htmlFiles, boundary);
    }
  }

  if (htmlFiles.length === 0) {
    console.error("No HTML files found.");
    process.exit(0);
  }

  /** App (.meteor) or package (package.js) roots found at or below the CLI targets, within the bound. */
  /** @type {Set<string>} */
  const allowedRoots = new Set();
  for (const target of targets) {
    const root = projectRootFor(path.resolve(target));
    if (root) allowedRoots.add(root);
  }
  for (const file of htmlFiles) {
    const root = projectRootFor(file);
    if (root) allowedRoots.add(root);
  }

  /** @type {Map<string, ProjectIndex>} meteorRoot → index */
  const indexes = new Map();

  if (isFileTraceEnabled()) {
    traceFiles(
      `cli start htmlTargets=${htmlFiles.length} allowedRoots=${[...allowedRoots].join("|") || "(none)"}`
    );
  }

  for (const root of allowedRoots) {
    const index = new ProjectIndex(root, { boundaryDirs });
    if (isFileTraceEnabled()) {
      traceFiles(`load begin meteorRoot=${root}`);
    }
    const t0 = Date.now();
    // Prefer index-cache.json (same as LSP cold start); full scan only on miss.
    const mode = index.loadForCli();
    if (isFileTraceEnabled()) {
      traceFiles(
        `load done mode=${mode} meteorRoot=${root} templates=${index.templateIndexer.size} ` +
        `components=${index.componentIndexer.size} elapsedMs=${Date.now() - t0}`
      );
    } else if (mode === "scan") {
      console.error(
        `[blaze-check] Indexed ${root} (${index.templateIndexer.size} templates, ` +
        `${index.componentIndexer.size} components) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
    }
    indexes.set(root, index);
  }

  if (indexes.size === 0) {
    console.error(
      "No Meteor app (.meteor) or package (package.js) root found for the given paths."
    );
    process.exit(1);
  }

  /** @type {Map<string, { errorOnTypeMismatch: boolean, errorOnMissingComponent: boolean }>} */
  const configs = new Map();

  for (const meteorRoot of indexes.keys()) {
    const config = { errorOnTypeMismatch, errorOnMissingComponent: false };
    const boundDir = boundDirFor(meteorRoot);
    const configPath = boundDir ? findConfigFile(meteorRoot, boundDir) : null;
    if (configPath) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (!errorOnTypeMismatch && typeof parsed.errorOnTypeMismatch === "boolean") {
          config.errorOnTypeMismatch = parsed.errorOnTypeMismatch;
        }
        if (typeof parsed.errorOnMissingComponent === "boolean") {
          config.errorOnMissingComponent = parsed.errorOnMissingComponent;
        }
      } catch {}
    }
    configs.set(meteorRoot, config);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;
  let totalFiles = 0;

  /** @type {Array<{file: string, diagnostics: any[]}>} */
  const allResults = [];

  for (const file of htmlFiles) {
    const projectRoot = projectRootFor(file);
    // Prefer the file's own root when it is one we intentionally scanned; otherwise
    // fall back to the single allowed root (package symlink HTML under this app).
    let indexRoot = projectRoot && indexes.has(projectRoot) ? projectRoot : undefined;
    if (!indexRoot && allowedRoots.size === 1) {
      indexRoot = [...allowedRoots][0];
    }
    const index = indexRoot ? indexes.get(indexRoot) : undefined;
    if (!index || !indexRoot) continue;
    const fileConfig = /** @type {NonNullable<ReturnType<typeof configs.get>>} */ (configs.get(indexRoot));

    const source = fs.readFileSync(file, "utf-8");
    const diagnostics = getDiagnostics(index, file, source, fileConfig);

    const filtered = quiet
      ? diagnostics.filter(d => d.severity === 1)
      : diagnostics;

    if (filtered.length === 0) continue;

    totalFiles++;
    const relPath = path.relative(process.cwd(), file);

    if (jsonOutput) {
      allResults.push({
        file: relPath,
        diagnostics: filtered.map(d => ({
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY_LABELS[/** @type {keyof SEVERITY_LABELS} */ (d.severity)] || "unknown",
          message: d.message
        }))
      });
    } else {
      const header = useColor ? `\n${BOLD}${relPath}${RESET}` : `\n${relPath}`;
      console.log(header);

      for (const d of filtered) {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const sev = d.severity;
        const label = SEVERITY_LABELS[/** @type {keyof SEVERITY_LABELS} */ (sev)] || "unknown";

        if (useColor) {
          const color = SEVERITY_COLORS[/** @type {keyof SEVERITY_COLORS} */ (sev)] || "";
          console.log(`  ${DIM}${line}:${col}${RESET}  ${color}${label}${RESET}  ${d.message}`);
        } else {
          console.log(`  ${line}:${col}  ${label}  ${d.message}`);
        }

        if (sev === 1) totalErrors++;
        else if (sev === 2) totalWarnings++;
        else totalInfos++;
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  } else {
    const parts = [];
    if (totalErrors > 0) parts.push(useColor ? `${SEVERITY_COLORS[1]}${totalErrors} error${totalErrors === 1 ? "" : "s"}${RESET}` : `${totalErrors} error${totalErrors === 1 ? "" : "s"}`);
    if (totalWarnings > 0) parts.push(useColor ? `${SEVERITY_COLORS[2]}${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}${RESET}` : `${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`);

    if (totalInfos > 0) parts.push(`${totalInfos} info${totalInfos === 1 ? "" : "s"}`);

    if (parts.length > 0) {
      console.log(`\n${parts.join(", ")} in ${totalFiles} file${totalFiles === 1 ? "" : "s"}\n`);
    } else {
      console.log(`\nNo issues found in ${htmlFiles.length} file${htmlFiles.length === 1 ? "" : "s"}\n`);
    }
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

/**
 * @param {string} dir
 * @param {string[]} results
 * @param {{ contains(p: string): boolean }} boundary
 */
function collectHtmlFiles(dir, results, boundary) {
  const IGNORE = new Set([
    "node_modules", ".meteor", ".git", ".deploy",
    "cordova-build-override", "public", "resources"
  ]);

  /** @type {fs.Dirent[]} */
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;

    // Follow package symlinks for traversal, but keep the *logical* path under the
    // CLI target. realpathSync would jump to shared_packages / other services and
    // expose nested .meteor roots (e.g. bootstrap-3-modal/examples), causing the
    // CLI to create extra ProjectIndexes and pull in foreign tsconfigs.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      if (!boundary.contains(full)) continue;
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }
    }

    if (isDir) {
      collectHtmlFiles(full, results, boundary);
    } else if (isFile && entry.name.endsWith(".html")) {
      results.push(full);
    }
  }
}

main();
