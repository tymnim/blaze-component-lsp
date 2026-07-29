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
  });

  documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    const filePath = uriToPath(uri);
    const source = change.document.getText();

    if (filePath.endsWith(".html") && projectIndex) {
      projectIndex.updateFile(filePath, source);
      scheduleDiagnostics(change.document);
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

  connection.onCompletion((params) => {
    if (!projectIndex) {
      connection.console.log("[completion] No project index");
      return [];
    }
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      connection.console.log("[completion] No document for " + params.textDocument.uri);
      return [];
    }

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    connection.console.log(`[completion] Request at ${filePath}:${line}:${character}`);
    const lineText = source.split("\n")[line] || "";
    connection.console.log(`[completion] Line text: "${lineText}"`);
    connection.console.log(`[completion] Text before cursor: "${lineText.slice(0, character)}"`);
    connection.console.log(`[completion] Templates indexed: ${projectIndex.templateIndexer.size}, Components: ${projectIndex.componentIndexer.size}`);

    const result = getCompletions(projectIndex, filePath, source, line, character);
    connection.console.log(`[completion] Returning ${result.length} items`);
    return result;
  });

  connection.onHover((params) => {
    if (!projectIndex) return null;
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
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const filePath = uriToPath(params.textDocument.uri);
    const source = doc.getText();
    const { line, character } = params.position;

    return getDefinition(projectIndex, filePath, source, line, character);
  });

  connection.onReferences((params) => {
    if (!projectIndex) return null;
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

  documents.listen(connection);

  return { connection, documents, getProjectIndex: () => projectIndex };
}

module.exports = { createServer };
