#!/usr/bin/env node
// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { ProjectIndex } = require("../server/indexer/projectIndex");
const { getDiagnostics } = require("../server/providers/diagnosticProvider");
const { findMeteorRoot } = require("../server/utils/uri");

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
  -h, --help                Show this help

${BOLD}Examples:${RESET}
  blaze-check .                          Check all HTML files under current directory
  blaze-check imports/ui/               Check a specific folder
  blaze-check imports/ui/views/index.html  Check a single file
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

  /** @type {string[]} */
  const htmlFiles = [];
  for (const target of targets) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      console.error(`Path not found: ${target}`);
      process.exit(1);
    }
    if (fs.statSync(resolved).isFile()) {
      if (resolved.endsWith(".html")) htmlFiles.push(resolved);
      else console.error(`Skipping non-HTML file: ${target}`);
    } else {
      collectHtmlFiles(resolved, htmlFiles);
    }
  }

  if (htmlFiles.length === 0) {
    console.error("No HTML files found.");
    process.exit(0);
  }

  /** @type {Map<string, ProjectIndex>} meteorRoot → index */
  const indexes = new Map();

  for (const file of htmlFiles) {
    const meteorRoot = findMeteorRoot(file);
    if (!meteorRoot) continue;
    if (!indexes.has(meteorRoot)) {
      const index = new ProjectIndex(meteorRoot);
      index.scan();
      indexes.set(meteorRoot, index);
    }
  }

  /** @type {{ errorOnTypeMismatch: boolean }} */
  let fileConfig = { errorOnTypeMismatch };

  for (const [meteorRoot, index] of indexes) {
    const configPath = path.join(meteorRoot, "blaze-component-config.json");
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!errorOnTypeMismatch && typeof parsed.errorOnTypeMismatch === "boolean") {
        fileConfig = { errorOnTypeMismatch: parsed.errorOnTypeMismatch };
      }
    } catch {}
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalFiles = 0;

  /** @type {Array<{file: string, diagnostics: any[]}>} */
  const allResults = [];

  for (const file of htmlFiles) {
    const meteorRoot = findMeteorRoot(file);
    if (!meteorRoot) continue;
    const index = indexes.get(meteorRoot);
    if (!index) continue;

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
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  } else {
    const parts = [];
    if (totalErrors > 0) parts.push(useColor ? `${SEVERITY_COLORS[1]}${totalErrors} error${totalErrors === 1 ? "" : "s"}${RESET}` : `${totalErrors} error${totalErrors === 1 ? "" : "s"}`);
    if (totalWarnings > 0) parts.push(useColor ? `${SEVERITY_COLORS[2]}${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}${RESET}` : `${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`);

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
 */
function collectHtmlFiles(dir, results) {
  const IGNORE = new Set([
    "node_modules", ".meteor", ".git", ".deploy",
    "cordova-build-override", "public", "resources"
  ]);

  /** @type {fs.Dirent[]} */
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
      try {
        const realPath = fs.realpathSync(full);
        if (fs.statSync(realPath).isDirectory()) {
          collectHtmlFiles(realPath, results);
        }
      } catch { continue; }
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      results.push(full);
    }
  }
}

main();
