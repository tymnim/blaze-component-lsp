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

  /** @type {ProjectIndex|null} */
  let projectIndex = null;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let diagnosticDebounce = null;

  connection.onInitialize((params) => {
    const workspaceFolders = params.workspaceFolders;
    let rootPath = null;

    if (workspaceFolders && workspaceFolders.length > 0) {
      rootPath = uriToPath(workspaceFolders[0].uri);
    } else if (params.rootUri) {
      rootPath = uriToPath(params.rootUri);
    } else if (params.rootPath) {
      rootPath = params.rootPath;
    }

    if (rootPath) {
      const meteorRoot = findMeteorRoot(rootPath);
      const scanRoot = meteorRoot || rootPath;
      projectIndex = new ProjectIndex(scanRoot);
      projectIndex.scan();
      connection.console.log(`[blaze-component-lsp] Indexed project at ${scanRoot}: ${projectIndex.templateIndexer.size} templates, ${projectIndex.componentIndexer.size} components`);
    }

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
    connection.console.log("[blaze-component-lsp] Server initialized");

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

    if (!projectIndex) return;

    if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
      projectIndex.updateFile(filePath, source);
      connection.console.log(`[sync] Re-indexed ${filePath}`);
    }

    if (filePath.endsWith(".html")) {
      scheduleDiagnostics(change.document);
    } else if (filePath.endsWith(".js")) {
      scheduleAllHtmlDiagnostics();
    }
  });

  documents.onDidOpen((event) => {
    if (event.document.uri.endsWith(".html") && projectIndex) {
      scheduleDiagnostics(event.document);
    }
  });

  documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!projectIndex) return;

    let jsChanged = false;
    for (const change of params.changes) {
      const filePath = uriToPath(change.uri);
      if (!filePath.endsWith(".html") && !filePath.endsWith(".js")) continue;

      if (change.type === 3 /* Deleted */) {
        projectIndex.removeFile(filePath);
        connection.console.log(`[watch] Removed ${filePath}`);
      } else {
        try {
          const source = fs.readFileSync(filePath, "utf-8");
          projectIndex.updateFile(filePath, source);
          connection.console.log(`[watch] Re-indexed ${filePath}`);
        } catch (err) {
          connection.console.log(`[watch] Failed to read ${filePath}: ${err}`);
        }
      }

      if (filePath.endsWith(".js")) jsChanged = true;
    }

    if (jsChanged) {
      scheduleAllHtmlDiagnostics();
    }
  });

  /**
   * Refresh stale JS files before serving a request.
   * Debounced: skips if checked within the last second.
   */
  let lastRefresh = 0;
  function ensureFreshIndex() {
    const now = Date.now();
    if (now - lastRefresh < 1000) return;
    lastRefresh = now;
    if (projectIndex && projectIndex.refreshStaleComponents()) {
      connection.console.log("[refresh] Re-indexed stale JS files");
    }
  }

  connection.onCompletion((params) => {
    if (!projectIndex) return [];
    ensureFreshIndex();

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    return getCompletions(projectIndex, filePath, source, line, character);
  });

  connection.onHover((params) => {
    if (!projectIndex) return null;
    ensureFreshIndex();

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    const result = getHover(projectIndex, filePath, source, line, character);
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
    if (!projectIndex) return null;
    ensureFreshIndex();

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    return getDefinition(projectIndex, filePath, source, line, character);
  });

  connection.onReferences((params) => {
    if (!projectIndex) return null;
    ensureFreshIndex();

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    return getReferences(projectIndex, filePath, source, line, character);
  });

  /**
   * Schedule diagnostics with debounce.
   * @param {TextDocument} document
   */
  function scheduleDiagnostics(document) {
    if (diagnosticDebounce) {
      clearTimeout(diagnosticDebounce);
    }
    diagnosticDebounce = setTimeout(() => {
      if (!projectIndex) return;
      const filePath = uriToPath(document.uri);
      const source = document.getText();
      const diagnostics = getDiagnostics(projectIndex, filePath, source);
      connection.sendDiagnostics({ uri: document.uri, diagnostics });
    }, 300);
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let htmlDiagnosticDebounce = null;

  /**
   * Re-run diagnostics on all open HTML documents (after a JS file changes).
   */
  function scheduleAllHtmlDiagnostics() {
    if (htmlDiagnosticDebounce) {
      clearTimeout(htmlDiagnosticDebounce);
    }
    htmlDiagnosticDebounce = setTimeout(() => {
      if (!projectIndex) return;
      for (const doc of documents.all()) {
        if (doc.uri.endsWith(".html")) {
          const filePath = uriToPath(doc.uri);
          const source = doc.getText();
          const diagnostics = getDiagnostics(projectIndex, filePath, source);
          connection.sendDiagnostics({ uri: doc.uri, diagnostics });
        }
      }
    }, 500);
  }

  documents.listen(connection);

  return { connection, documents, getProjectIndex: () => projectIndex };
}

module.exports = { createServer };
