import type { ExtensionContext } from 'vscode';
import { initExtension } from '@tomjs/vscode';
import { languages } from 'vscode';
import { CatalogCodeLensProvider } from './catalogCodeLensProvider';
import { registerCommands } from './commands';
import { ExtensionState } from './extensionState';

export function activate(context: ExtensionContext) {
  initExtension(context);

  const state = new ExtensionState(context);
  const provider = new CatalogCodeLensProvider(state);

  context.subscriptions.push(
    languages.registerCodeLensProvider([{ language: 'json', scheme: 'file' }], provider),
  );

  registerCommands(context, state, provider);

  void state.init();
}

export function deactivate() {}
