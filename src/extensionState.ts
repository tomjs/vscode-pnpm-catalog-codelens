import type { ExtensionContext } from 'vscode';
import { commands } from 'vscode';

const ENABLED_KEY = 'pnpmCatalog.enabled';
const CONTEXT_KEY = 'pnpmCatalog.enabled';

/**
 * Persists the on/off state of the catalog service per workspace and mirrors
 * it into a `when`-clause context key that drives the editor title bar icon.
 */
export class ExtensionState {
  private readonly context: ExtensionContext;

  constructor(context: ExtensionContext) {
    this.context = context;
  }

  get enabled(): boolean {
    return this.context.workspaceState.get<boolean>(ENABLED_KEY, false) ?? false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.context.workspaceState.update(ENABLED_KEY, enabled);
    await commands.executeCommand('setContext', CONTEXT_KEY, enabled);
  }

  async toggle(): Promise<boolean> {
    const next = !this.enabled;
    await this.setEnabled(next);
    return next;
  }

  /** Initialises the context key from the persisted value at activation. */
  async init(): Promise<void> {
    await commands.executeCommand('setContext', CONTEXT_KEY, this.enabled);
  }
}
