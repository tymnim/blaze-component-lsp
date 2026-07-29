// @ts-check
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { workspace, window } = vscode;
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

/** @type {LanguageClient|undefined} */
let client;

/**
 * Check if a directory contains .meteor anywhere up to 4 levels deep.
 * @param {string} dir
 * @param {number} [depth=0]
 * @returns {boolean}
 */
function hasMeteorProject(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, ".meteor"))) return true;
  if (depth >= 4) return false;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (hasMeteorProject(path.join(dir, entry.name), depth + 1)) return true;
    }
  } catch {}
  return false;
}

/**
 * @param {import("vscode").ExtensionContext} context
 */
function activate(context) {
  const config = workspace.getConfiguration("blazeComponentLsp");
  if (config.get("enable") === false) {
    return;
  }

  const outputChannel = window.createOutputChannel("Blaze Component LSP");

  const folders = workspace.workspaceFolders || [];
  outputChannel.appendLine(`[blaze-lsp] Workspace folders: ${folders.map(f => f.uri.fsPath).join(", ") || "(none)"}`);

  const hasMeteor = folders.some(folder => hasMeteorProject(folder.uri.fsPath));
  outputChannel.appendLine(`[blaze-lsp] Has Meteor project: ${hasMeteor}`);

  if (!hasMeteor) {
    outputChannel.appendLine("[blaze-lsp] No Meteor project found, not activating");
    return;
  }

  const extensionDir = context.extensionPath;
  const configuredPath = config.get("serverPath");
  let serverModule;
  if (configuredPath) {
    serverModule = configuredPath.replace(/^~/, process.env.HOME || "");
  } else {
    // Try relative (works when symlinked from the repo)
    serverModule = path.resolve(extensionDir, "..", "..", "server", "index.js");
    if (!fs.existsSync(serverModule)) {
      const realExtDir = fs.realpathSync(extensionDir);
      serverModule = path.resolve(realExtDir, "..", "..", "server", "index.js");
    }
  }

  outputChannel.appendLine(`[blaze-lsp] Extension path: ${extensionDir}`);
  outputChannel.appendLine(`[blaze-lsp] Server module: ${serverModule}`);

  if (!fs.existsSync(serverModule)) {
    outputChannel.appendLine(`[blaze-lsp] ERROR: server not found`);
    window.showErrorMessage(`Blaze Component LSP: server not found at ${serverModule}`);
    return;
  }

  outputChannel.appendLine(`[blaze-lsp] Starting server...`);

  /** @type {import("vscode-languageclient/node").ServerOptions} */
  const serverOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] }
    }
  };

  /** @type {import("vscode-languageclient/node").LanguageClientOptions} */
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "html" }],
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher("**/*.html"),
        workspace.createFileSystemWatcher("**/*.js")
      ]
    },
    outputChannelName: "Blaze Component LSP"
  };

  client = new LanguageClient(
    "blazeComponentLsp",
    "Blaze Component LSP",
    serverOptions,
    clientOptions
  );

  client.start();

  const onType = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId !== "html") return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) return;

    for (const change of e.contentChanges) {
      const ch = change.text;
      if (ch === "#" || ch === ">" || ch === "{") {
        setTimeout(() => {
          const pos = editor.selection.active;
          const lineText = e.document.lineAt(pos.line).text;
          const before = lineText.slice(0, pos.character);
          outputChannel.appendLine(`[trigger] typed="${ch}" before="${before.slice(-10)}"`);
          if (before.endsWith("{{#") || before.endsWith("{{>")) {
            outputChannel.appendLine("[trigger] firing editor.action.triggerSuggest");
            vscode.commands.executeCommand("editor.action.triggerSuggest");
          }
        }, 50);
        return;
      }
    }
  });
  context.subscriptions.push(onType);
}

function deactivate() {
  if (client) {
    return client.stop();
  }
}

module.exports = { activate, deactivate };
