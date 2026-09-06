'use strict';
// Minimal VS Code API mock so the built extension (dist/index.js) can run
// under plain node. Intercepts require('vscode') on first load and exports a
// singleton so every consumer shares one instance.
const fs = require('node:fs');
const Module = require('node:module');

const existing = globalThis.__PNPM_CATALOG_VSCODE_MOCK__;
if (existing) {
  module.exports = existing;
}
else {
  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }

  class Range {
    // supports both new Range(start, end) and new Range(sLine, sChar, eLine, eChar)
    constructor(startOrLine, endOrChar, endLine, endChar) {
      if (endLine !== undefined) {
        this.start = new Position(startOrLine, endOrChar);
        this.end = new Position(endLine, endChar);
      }
      else {
        this.start = startOrLine;
        this.end = endOrChar;
      }
    }
  }

  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
    }

    static file(p) {
      return new Uri(p);
    }

    static parse(s) {
      return new Uri(s.replace(/^file:\/\//, ''));
    }

    toString() {
      return `file://${this.fsPath}`;
    }
  }

  class CodeLens {
    constructor(range) {
      this.range = range;
      this.command = null;
    }
  }

  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }

    fire() {}
  }

  class WorkspaceEdit {
    constructor() {
      this.creates = [];
      this.entries = [];
    }

    get size() {
      return this.creates.length + this.entries.length;
    }

    createFile(uri) {
      this.creates.push(uri);
    }

    replace(uri, range, newText) {
      this.entries.push([uri, { range, newText }]);
    }
  }

  class TextDocument {
    constructor(uri, text) {
      this.uri = uri;
      this.text = text;
    }

    getText() {
      return this.text;
    }

    get fileName() {
      return this.uri.fsPath;
    }

    save() {
      fs.writeFileSync(this.uri.fsPath, this.text);
      return Promise.resolve(true);
    }

    positionAt(offset) {
      const before = this.text.slice(0, offset).split('\n');
      return new Position(before.length - 1, before[before.length - 1].length);
    }
  }

  function offsetAt(text, pos) {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++)
      offset += lines[i].length + 1;
    return offset + pos.character;
  }

  const state = {
    openDocs: new Map(),
    registeredCommands: {},
    messages: [],
    pickQueue: [],
    inputQueue: [],
    msgQueue: [],
    provider: null,
  };

  const api = {
    Position,
    Range,
    Uri,
    CodeLens,
    EventEmitter,
    WorkspaceEdit,
    TextDocument,
    version: '1.90.0',
    env: { language: 'en' },
    languages: {
      registerCodeLensProvider(_selector, provider) {
        state.provider = provider;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(id, fn) {
        state.registeredCommands[id] = fn;
        return { dispose() {} };
      },
      executeCommand: async () => {},
    },
    workspace: {
      textDocuments: [],
      workspaceRoot: null,
      getWorkspaceFolder: (uri) => {
        const root = api.workspace.workspaceRoot;
        return root && uri.fsPath.startsWith(root) ? { uri: { fsPath: root } } : undefined;
      },
      openTextDocument: async (uri) => {
        if (!state.openDocs.has(uri.fsPath))
          state.openDocs.set(uri.fsPath, new TextDocument(uri, fs.readFileSync(uri.fsPath, 'utf8')));
        return state.openDocs.get(uri.fsPath);
      },
      applyEdit: async (edit) => {
        for (const uri of edit.creates) {
          if (!fs.existsSync(uri.fsPath) && !state.openDocs.has(uri.fsPath))
            fs.writeFileSync(uri.fsPath, '');
        }
        for (const [uri, { range, newText }] of edit.entries) {
          const open = state.openDocs.get(uri.fsPath);
          const text = open ? open.text : fs.readFileSync(uri.fsPath, 'utf8');
          const start = offsetAt(text, range.start);
          const end = offsetAt(text, range.end);
          const next = text.slice(0, start) + newText + text.slice(end);
          if (open)
            open.text = next;
          else
            fs.writeFileSync(uri.fsPath, next);
        }
        return true;
      },
    },
    window: {
      showInformationMessage: (m, ...items) => {
        state.messages.push(String(m));
        return state.msgQueue.length ? state.msgQueue.shift() : (typeof items[0] === 'string' ? items[0] : undefined);
      },
      showWarningMessage: (m) => {
        state.messages.push(String(m));
      },
      showErrorMessage: (m) => {
        state.messages.push(String(m));
      },
      showQuickPick: async items => (state.pickQueue.length ? state.pickQueue.shift() : items[0]),
      showInputBox: async () => (state.inputQueue.length ? state.inputQueue.shift() : undefined),
    },
    _hooks: {
      state,
      provider: () => state.provider,
      createWorkspaceState() {
        const store = Object.create(null);
        return {
          get: (key, defaultValue) => (key in store ? store[key] : defaultValue),
          update: async (key, value) => {
            store[key] = value;
          },
        };
      },
      reset() {
        state.openDocs.clear();
        for (const key of Object.keys(state.registeredCommands))
          delete state.registeredCommands[key];
        state.messages.length = 0;
        state.pickQueue.length = 0;
        state.inputQueue.length = 0;
        state.msgQueue.length = 0;
        state.provider = null;
      },
    },
  };

  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode')
      return __filename;
    return originalResolve.call(this, request, ...args);
  };

  globalThis.__PNPM_CATALOG_VSCODE_MOCK__ = api;
  module.exports = api;
}
