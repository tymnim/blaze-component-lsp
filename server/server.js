// @ts-check
const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  CompletionItemKind,
  DiagnosticSeverity
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const fs = require("node:fs");
const { ProjectIndex } = require("./indexer/projectIndex");
const { getCompletions } = require("./providers/completionProvider");
const { getHover } = require("./providers/hoverProvider");
const { getDefinition } = require("./providers/definitionProvider");
const { getDiagnostics } = require("./providers/diagnosticProvider");
const { getReferences } = require("./providers/referenceProvider");
const { uriToPath, findMeteorRoot } = require("./utils/uri");

/**
 * Create and configure the LSP server.
 * @param {import("vscode-languageserver/node").Connection} connection
 */
function createServer(connection) {
  const documents = new TextDocuments(TextDocument);

  /** @type {Map<string, ProjectIndex>} meteorRoot → ProjectIndex */
  const projectIndexes = new Map();

  /** @type {Map<string, number>} meteorRoot → last refresh timestamp */
  const lastRefreshTimes = new Map();

  /** @type {ReturnType<typeof setTimeout>|null} */
  let diagnosticDebounce = null;

  /**
   * Get or create a ProjectIndex for the Meteor app containing the given file.
   * @param {string} filePath
   * @returns {ProjectIndex|null}
   */
  function getIndexForFile(filePath) {
    const meteorRoot = findMeteorRoot(filePath);
    if (!meteorRoot) return null;

    let index = projectIndexes.get(meteorRoot);
    if (!index) {
      index = new ProjectIndex(meteorRoot);
      index.scan();
      projectIndexes.set(meteorRoot, index);
      connection.console.log(`[blaze-component-lsp] Indexed app at ${meteorRoot}: ${index.templateIndexer.size} templates, ${index.componentIndexer.size} components`);
    }
    return index;
  }

  /**
   * Refresh stale JS files for a specific index.
   * Debounced per meteor root: skips if checked within the last second.
   * @param {string} filePath
   * @param {ProjectIndex} index
   */
  function ensureFreshIndex(filePath, index) {
    const meteorRoot = findMeteorRoot(filePath) || filePath;
    const now = Date.now();
    const lastRefresh = lastRefreshTimes.get(meteorRoot) || 0;
    if (now - lastRefresh < 1000) return;
    lastRefreshTimes.set(meteorRoot, now);
    if (index.refreshStaleComponents()) {
      connection.console.log(`[refresh] Re-indexed stale JS files for ${meteorRoot}`);
    }
  }

  connection.onInitialize(() => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: ["{", ">", " ", "="],
          resolveProvider: false
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true
      }
    };
  });

  connection.onInitialized(() => {
    connection.console.log("[blaze-component-lsp] Server initialized (lazy per-app indexing)");

    connection.client.register(
      require("vscode-languageserver").DidChangeWatchedFilesNotification.type,
      {
        watchers: [
          { globPattern: "**/*.js" },
          { globPattern: "**/*.html" }
        ]
      }
    ).then(() => {
      connection.console.log("[blaze-component-lsp] Registered file watchers");
    }).catch((err) => {
      connection.console.log(`[blaze-component-lsp] File watcher registration failed: ${err}`);
    });
  });

  documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    const filePath = uriToPath(uri);
    const source = change.document.getText();

    if (!filePath.endsWith(".html") && !filePath.endsWith(".js")) return;

    const index = getIndexForFile(filePath);
    if (!index) return;

    index.updateFile(filePath, source);
    connection.console.log(`[sync] Re-indexed ${filePath}`);

    if (filePath.endsWith(".html")) {
      scheduleDiagnostics(change.document);
    } else if (filePath.endsWith(".js")) {
      scheduleHtmlDiagnosticsForIndex(index);
    }
  });

  documents.onDidOpen((event) => {
    if (event.document.uri.endsWith(".html")) {
      const filePath = uriToPath(event.document.uri);
      const index = getIndexForFile(filePath);
      if (index) {
        scheduleDiagnostics(event.document);
      }
    }
  });

  documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onDidChangeWatchedFiles((params) => {
    /** @type {Set<ProjectIndex>} */
    const jsChangedIndexes = new Set();

    for (const change of params.changes) {
      const filePath = uriToPath(change.uri);
      if (!filePath.endsWith(".html") && !filePath.endsWith(".js")) continue;

      const index = getIndexForFile(filePath);
      if (!index) continue;

      if (change.type === 3 /* Deleted */) {
        index.removeFile(filePath);
        connection.console.log(`[watch] Removed ${filePath}`);
      } else {
        try {
          const source = fs.readFileSync(filePath, "utf-8");
          index.updateFile(filePath, source);
          connection.console.log(`[watch] Re-indexed ${filePath}`);
        } catch (err) {
          connection.console.log(`[watch] Failed to read ${filePath}: ${err}`);
        }
      }

      if (filePath.endsWith(".js")) jsChangedIndexes.add(index);
    }

    for (const index of jsChangedIndexes) {
      scheduleHtmlDiagnosticsForIndex(index);
    }
  });

  connection.onCompletion((params) => {
    const filePath = uriToPath(params.textDocument.uri);
    const index = getIndexForFile(filePath);
    if (!index) return [];
    ensureFreshIndex(filePath, index);

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const source = doc.getText();
    const { line, character } = params.position;

    const result = getCompletions(index, filePath, source, line, character);
    connection.console.log(`[completion] ${filePath}:${line}:${character} → ${result.length} items`);
    return result;
  });

  connection.onHover((params) => {
    const filePath = uriToPath(params.textDocument.uri);
    const index = getIndexForFile(filePath);
    if (!index) return null;
    ensureFreshIndex(filePath, index);

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const source = doc.getText();
    const { line, character } = params.position;

    const result = getHover(index, filePath, source, line, character);
    if (!result) return null;

    return {
      contents: { kind: "markdown", value: result.contents },
      range: result.range ? {
        start: { line: result.range.start.line, character: result.range.start.column },
        end: { line: result.range.end.line, character: result.range.end.column }
      } : undefined
    };
  });

  connection.onDefinition((params) => {
    const filePath = uriToPath(params.textDocument.uri);
    const index = getIndexForFile(filePath);
    if (!index) return null;
    ensureFreshIndex(filePath, index);

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const source = doc.getText();
    const { line, character } = params.position;

    return getDefinition(index, filePath, source, line, character);
  });

  connection.onReferences((params) => {
    const filePath = uriToPath(params.textDocument.uri);
    const index = getIndexForFile(filePath);
    if (!index) return null;
    ensureFreshIndex(filePath, index);

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const source = doc.getText();
    const { line, character } = params.position;

    return getReferences(index, filePath, source, line, character);
  });

  /**
   * Schedule diagnostics with debounce for a single document.
   * @param {TextDocument} document
   */
  function scheduleDiagnostics(document) {
    if (diagnosticDebounce) {
      clearTimeout(diagnosticDebounce);
    }
    diagnosticDebounce = setTimeout(() => {
      const filePath = uriToPath(document.uri);
      const index = getIndexForFile(filePath);
      if (!index) return;
      const source = document.getText();
      const diagnostics = getDiagnostics(index, filePath, source);
      connection.sendDiagnostics({ uri: document.uri, diagnostics });
    }, 300);
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let htmlDiagnosticDebounce = null;

  /**
   * Re-run diagnostics on all open HTML documents belonging to a specific index.
   * @param {ProjectIndex} targetIndex
   */
  function scheduleHtmlDiagnosticsForIndex(targetIndex) {
    if (htmlDiagnosticDebounce) {
      clearTimeout(htmlDiagnosticDebounce);
    }
    htmlDiagnosticDebounce = setTimeout(() => {
      for (const doc of documents.all()) {
        if (!doc.uri.endsWith(".html")) continue;
        const filePath = uriToPath(doc.uri);
        const index = getIndexForFile(filePath);
        if (index !== targetIndex) continue;
        const source = doc.getText();
        const diagnostics = getDiagnostics(index, filePath, source);
        connection.sendDiagnostics({ uri: doc.uri, diagnostics });
      }
    }, 500);
  }

  documents.listen(connection);

  return { connection, documents, getIndexForFile };
}

module.exports = { createServer };
