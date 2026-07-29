#!/usr/bin/env node
// @ts-check

const { createConnection, ProposedFeatures } = require("vscode-languageserver/node");
const { createServer } = require("./server");

const connection = createConnection(ProposedFeatures.all);
const server = createServer(connection);

connection.listen();
