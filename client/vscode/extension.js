// @ts-check
const path = require("node:path");
const { workspace, window } = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

/** @type {LanguageClient|undefined} */
let client;

/**
 * @param {import("vscode").ExtensionContext} context
 */
function activate(context) {
  const config = workspace.getConfiguration("blazeComponentLsp");
  if (config.get("enable") === false) {
    return;
  }

  const hasMeteor = workspace.workspaceFolders?.some(folder => {
    const fs = require("node:fs");
    return fs.existsSync(path.join(folder.uri.fsPath, ".meteor"));
  });

  if (!hasMeteor) {
    return;
  }

  const serverModule = context.asAbsolutePath(
    path.join("..", "..", "server", "index.js")
  );

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
}

function deactivate() {
  if (client) {
    return client.stop();
  }
}

module.exports = { activate, deactivate };
