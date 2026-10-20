// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/** @type {boolean} */
let fileTraceEnabled =
  process.env.BLAZE_COMPONENT_LSP_TRACE_FILES === "1" ||
  process.env.BLAZE_COMPONENT_LSP_TRACE_FILES === "true";

/**
 * Enable/disable per-file open tracing (also set via BLAZE_COMPONENT_LSP_TRACE_FILES=1).
 * @param {boolean} enabled
 */
function setFileTraceEnabled(enabled) {
  fileTraceEnabled = !!enabled;
}

/**
 * @returns {boolean}
 */
function isFileTraceEnabled() {
  return fileTraceEnabled;
}

/**
 * @param {string} message
 */
function traceFiles(message) {
  if (!fileTraceEnabled) return;
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  console.error(`[blaze-trace] heap=${heapMB}MB rss=${rssMB}MB ${message}`);
}

/**
 * Per-Meteor-root TypeScript LanguageService wrapper.
 * Resolves types via the real checker; supports file overlays for open buffers.
 */
class TypeService {
  /**
   * @param {string} rootPath - Meteor project root (directory containing .meteor)
   */
  constructor(rootPath) {
    this.rootPath = rootPath;
    /** @type {Map<string, { version: number, content: string }>} */
    this._overlays = new Map();
    /** @type {Map<string, number>} path → version for disk files without overlay */
    this._versions = new Map();
    /** @type {string[]} */
    this._rootFileNames = [];
    /** @type {ts.CompilerOptions} */
    this._compilerOptions = {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
      baseUrl: rootPath
    };
    /** @type {ts.LanguageService|null} */
    this._languageService = null;
    /** @type {string|null} */
    this._syntheticPath = path.join(rootPath, "__blaze_component_lsp_types__.ts");
    /** @type {number} */
    this._syntheticVersion = 0;
    /** @type {boolean} */
    this._ready = false;
    /** @type {string} */
    this._syntheticContent = "export {};\n";
    /** @type {Set<string>} */
    this._tracedOpens = new Set();
    /** @type {number} */
    this._tracedOpenCount = 0;
  }

  /**
   * Lazily load tsconfig + create the LanguageService (expensive).
   * Safe to call repeatedly.
   */
  ensureReady() {
    if (this._ready) return;
    const t0 = Date.now();
    this._loadConfig();
    if (fileTraceEnabled) {
      const byTop = new Map();
      for (const f of this._rootFileNames) {
        const rel = path.relative(this.rootPath, f);
        const top = rel.split(path.sep).slice(0, 2).join("/") || rel;
        byTop.set(top, (byTop.get(top) || 0) + 1);
      }
      const summary = [...byTop.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      traceFiles(
        `TypeService ensureReady root=${this.rootPath} rootFiles=${this._rootFileNames.length} top=[${summary}]`
      );
    }
    this._createLanguageService();
    this._ready = true;
    // Force program construction so opens are visible during profiling
    if (fileTraceEnabled) {
      const program = this._languageService && this._languageService.getProgram();
      const n = program ? program.getSourceFiles().length : 0;
      traceFiles(
        `TypeService ready programFiles=${n} opens=${this._tracedOpenCount} elapsedMs=${Date.now() - t0}`
      );
    }
  }

  /**
   * Log the first time a path is loaded into the LanguageService.
   * @param {string} fileName
   * @param {number} [byteLength]
   * @param {string} [via]
   */
  _traceOpen(fileName, byteLength, via) {
    if (!fileTraceEnabled || this._tracedOpens.has(fileName)) return;
    this._tracedOpens.add(fileName);
    this._tracedOpenCount++;
    const rel = path.relative(this.rootPath, fileName);
    const display = rel && !rel.startsWith("..") ? rel : fileName;
    const size = byteLength !== undefined ? ` bytes=${byteLength}` : "";
    traceFiles(`open #${this._tracedOpenCount}${size} via=${via || "snapshot"} ${display}`);
  }

  /**
   * Whether the LanguageService has been created.
   * @returns {boolean}
   */
  get isReady() {
    return this._ready;
  }

  /**
   * Load tsconfig.json from the project root if present.
   *
   * Only accepts a tsconfig inside this Meteor root. `ts.findConfigFile` walks
   * parent directories and would otherwise pick up the monorepo-root tsconfig
   * (e.g. when the root is a nested package `.meteor` like
   * `bootstrap-3-modal/examples`), pulling unrelated services into the program.
   */
  _loadConfig() {
    const localConfig = path.join(this.rootPath, "tsconfig.json");
    const configPath = fs.existsSync(localConfig) ? localConfig : null;

    if (!configPath) {
      this._rootFileNames = this._collectJsFiles(this.rootPath);
      return;
    }

    const configFile = ts.readConfigFile(configPath, (p) => fs.readFileSync(p, "utf-8"));
    if (configFile.error) {
      this._rootFileNames = this._collectJsFiles(this.rootPath);
      return;
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath
    );

    this._compilerOptions = {
      ...parsed.options,
      allowJs: parsed.options.allowJs !== false ? true : parsed.options.allowJs,
      checkJs: parsed.options.checkJs !== false ? true : parsed.options.checkJs,
      noEmit: true,
      skipLibCheck: true
    };

    // Prefer JS/TS source files from the config; if the include set is empty/huge,
    // fall back to a bounded scan of the project root.
    const fromConfig = parsed.fileNames.filter((f) =>
      /\.(js|jsx|ts|tsx|d\.ts)$/.test(f) && !f.includes("node_modules")
    );
    this._rootFileNames = fromConfig.length > 0
      ? fromConfig
      : this._collectJsFiles(this.rootPath);
  }

  /**
   * Collect .js/.ts files under a directory (bounded, ignores common dirs).
   * @param {string} dir
   * @returns {string[]}
   */
  _collectJsFiles(dir) {
    const IGNORE = new Set([
      "node_modules", ".meteor", ".git", ".deploy",
      "cordova-build-override", "public", "resources"
    ]);
    /** @type {string[]} */
    const files = [];

    /** @param {string} d */
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (IGNORE.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && /\.(js|jsx|ts|tsx|d\.ts)$/.test(entry.name)) {
          files.push(full);
        }
      }
    };

    walk(dir);
    return files;
  }

  _createLanguageService() {
    const service = this;
    /** @type {ts.LanguageServiceHost} */
    const host = {
      getCompilationSettings: () => service._compilerOptions,
      getScriptFileNames: () => {
        const names = new Set(service._rootFileNames);
        for (const p of service._overlays.keys()) names.add(p);
        names.add(service._syntheticPath);
        return Array.from(names);
      },
      getScriptVersion: (fileName) => {
        const overlay = service._overlays.get(fileName);
        if (overlay) return String(overlay.version);
        if (fileName === service._syntheticPath) return String(service._syntheticVersion);
        const v = service._versions.get(fileName);
        if (v !== undefined) return String(v);
        try {
          return String(fs.statSync(fileName).mtimeMs);
        } catch {
          return "0";
        }
      },
      getScriptSnapshot: (fileName) => {
        const overlay = service._overlays.get(fileName);
        if (overlay) {
          service._traceOpen(fileName, Buffer.byteLength(overlay.content, "utf8"), "overlay");
          return ts.ScriptSnapshot.fromString(overlay.content);
        }
        if (fileName === service._syntheticPath) {
          const content = service._syntheticContent || "export {};\n";
          service._traceOpen(fileName, Buffer.byteLength(content, "utf8"), "synthetic");
          return ts.ScriptSnapshot.fromString(content);
        }
        try {
          const content = fs.readFileSync(fileName, "utf-8");
          service._traceOpen(fileName, Buffer.byteLength(content, "utf8"), "snapshot");
          return ts.ScriptSnapshot.fromString(content);
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => service.rootPath,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) =>
        service._overlays.has(fileName) ||
        fileName === service._syntheticPath ||
        ts.sys.fileExists(fileName),
      readFile: (fileName) => {
        const overlay = service._overlays.get(fileName);
        if (overlay) {
          service._traceOpen(fileName, Buffer.byteLength(overlay.content, "utf8"), "readFile-overlay");
          return overlay.content;
        }
        if (fileName === service._syntheticPath) {
          const content = service._syntheticContent || "export {};\n";
          service._traceOpen(fileName, Buffer.byteLength(content, "utf8"), "readFile-synthetic");
          return content;
        }
        const content = ts.sys.readFile(fileName);
        if (content !== undefined) {
          service._traceOpen(fileName, Buffer.byteLength(content, "utf8"), "readFile");
        }
        return content;
      },
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath
    };

    this._languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /**
   * Update or create a file overlay (e.g. unsaved editor buffer).
   * @param {string} filePath
   * @param {string} content
   */
  updateFile(filePath, content) {
    const existing = this._overlays.get(filePath);
    const version = existing ? existing.version + 1 : 1;
    this._overlays.set(filePath, { version, content });
    if (this._ready && !this._rootFileNames.includes(filePath)) {
      this._rootFileNames.push(filePath);
    } else if (!this._ready) {
      // Queue path so ensureReady()'s root list can pick it up via overlays
      if (!this._rootFileNames.includes(filePath)) {
        this._rootFileNames.push(filePath);
      }
    }
  }

  /**
   * Drop an overlay; subsequent reads come from disk.
   * @param {string} filePath
   */
  removeFile(filePath) {
    this._overlays.delete(filePath);
    const v = this._versions.get(filePath) || 0;
    this._versions.set(filePath, v + 1);
  }

  /**
   * Bump version so the LS re-reads from disk after an external change.
   * @param {string} filePath
   */
  invalidateFile(filePath) {
    if (this._overlays.has(filePath)) return;
    const v = this._versions.get(filePath) || 0;
    this._versions.set(filePath, v + 1);
  }

  /**
   * @returns {ts.Program|undefined}
   */
  getProgram() {
    this.ensureReady();
    return this._languageService ? this._languageService.getProgram() : undefined;
  }

  /**
   * @returns {ts.TypeChecker|undefined}
   */
  getChecker() {
    this.ensureReady();
    const program = this.getProgram();
    return program ? program.getTypeChecker() : undefined;
  }

  /**
   * @param {ts.Type} type
   * @param {ts.Node} [enclosingNode]
   * @returns {string}
   */
  getTypeString(type, enclosingNode) {
    const checker = this.getChecker();
    if (!checker) return "any";
    return checker.typeToString(
      type,
      enclosingNode,
      ts.TypeFormatFlags.NoTruncation
    );
  }

  /**
   * True if `actual` is assignable to `expected`.
   * @param {ts.Type} actual
   * @param {ts.Type} expected
   * @returns {boolean}
   */
  isAssignable(actual, expected) {
    const checker = this.getChecker();
    if (!checker) return actual === expected;
    if (expected.flags & ts.TypeFlags.Any || expected.flags & ts.TypeFlags.Unknown) return true;
    if (actual.flags & ts.TypeFlags.Any) return true;
    return checker.isTypeAssignableTo(actual, expected);
  }

  /**
   * Parse type strings in a synthetic file and check assignability.
   * Falls back to simple string equality if parsing fails.
   * @param {string} actualStr
   * @param {string} expectedStr
   * @returns {boolean}
   */
  isAssignableByString(actualStr, expectedStr) {
    if (!actualStr || !expectedStr) return true;
    if (actualStr === expectedStr) return true;
    if (expectedStr === "any" || expectedStr === "unknown") return true;

    // Do not force LanguageService creation during cold boot / background scan.
    // Callers that need the checker should call ensureReady() explicitly first.
    if (!this._ready) {
      return fallbackStringMatch(actualStr, expectedStr);
    }

    const checker = this.getChecker();
    if (!checker) {
      return fallbackStringMatch(actualStr, expectedStr);
    }

    const types = this._resolveTypeStrings(actualStr, expectedStr);
    if (!types) {
      return fallbackStringMatch(actualStr, expectedStr);
    }
    return this.isAssignable(types.actual, types.expected);
  }

  /**
   * Resolve two type strings via a synthetic ambient module.
   * @param {string} actualStr
   * @param {string} expectedStr
   * @returns {{ actual: ts.Type, expected: ts.Type }|null}
   */
  _resolveTypeStrings(actualStr, expectedStr) {
    const content =
      `type __BlazeActual = ${actualStr};\n` +
      `type __BlazeExpected = ${expectedStr};\n` +
      `export {};\n`;

    this._syntheticContent = content;
    this._syntheticVersion++;

    const program = this.getProgram();
    const checker = this.getChecker();
    if (!program || !checker) return null;

    const sf = program.getSourceFile(this._syntheticPath);
    if (!sf) return null;

    /** @type {ts.Type|undefined} */
    let actual;
    /** @type {ts.Type|undefined} */
    let expected;

    for (const stmt of sf.statements) {
      if (ts.isTypeAliasDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
        const t = checker.getTypeFromTypeNode(stmt.type);
        if (stmt.name.text === "__BlazeActual") actual = t;
        if (stmt.name.text === "__BlazeExpected") expected = t;
      }
    }

    if (!actual || !expected) return null;
    return { actual, expected };
  }

  /**
   * Get a SourceFile from the program by absolute path.
   * @param {string} filePath
   * @returns {ts.SourceFile|undefined}
   */
  getSourceFile(filePath) {
    this.ensureReady();
    const program = this.getProgram();
    if (!program) return undefined;
    return program.getSourceFile(filePath);
  }
}

/**
 * Legacy string union matching used when the checker cannot parse a type string.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function fallbackStringMatch(actual, expected) {
  if (actual === expected) return true;
  const parts = expected.split(/\s*\|\s*/);
  return parts.some(p => p.trim() === actual || p.trim() === "any" || p.trim() === "unknown");
}

module.exports = {
  TypeService,
  fallbackStringMatch,
  setFileTraceEnabled,
  isFileTraceEnabled,
  traceFiles
};
