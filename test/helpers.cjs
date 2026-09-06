'use strict';
const path = require('node:path');
// Requiring the mock installs the require('vscode') interception - keep it first.
const mock = require('./mocks/vscode.cjs');

let dist;

/**
 * Activates the built extension against a project root and returns its entry
 * points. Enables the catalog service by default (the extension itself starts
 * disabled); pass `{ enabled: false }` to keep it off.
 */
async function activate(root, { enabled = true } = {}) {
  if (!dist)
    dist = require('../dist/index.js');
  mock._hooks.reset();
  mock.workspace.workspaceRoot = root;
  dist.activate({
    extensionPath: path.resolve(__dirname, '..'),
    subscriptions: [],
    workspaceState: mock._hooks.createWorkspaceState(),
  });
  const commands = mock._hooks.state.registeredCommands;
  if (enabled)
    await commands['tomjs.pnpmCatalog.enable']();
  return {
    commands,
    addToCatalog: commands['tomjs.pnpmCatalog.addToCatalog'],
    provider: mock._hooks.provider(),
  };
}

/** Returns CodeLens titles for a document keyed by "line:package". */
function lensTitlesByLine(provider, doc) {
  const map = new Map();
  for (const lens of provider.provideCodeLenses(doc)) {
    const key = `${lens.range.start.line}:${lens.command.arguments[0].packageName}`;
    if (!map.has(key))
      map.set(key, []);
    map.get(key).push(lens.command.title);
  }
  return map;
}

module.exports = { mock, activate, lensTitlesByLine };
