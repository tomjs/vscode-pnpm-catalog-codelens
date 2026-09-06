import type { ExtensionContext, QuickPickItem, TextDocument } from 'vscode';
import type { AddToCatalogArgs, CatalogCodeLensProvider } from './catalogCodeLensProvider';
import type { ExtensionState } from './extensionState';
import type { ParsedDependency } from './packageJsonParser';
import * as path from 'node:path';
import { i18n } from '@tomjs/vscode';
import {
  commands,

  Range,

  Uri,
  window,
  workspace,
  WorkspaceEdit,
} from 'vscode';
import {

  reservedCatalogNames,
} from './catalogCodeLensProvider';
import {
  applyCatalogStyle,
  catalogProtocol,
  findInstalledVersion,
  getCatalogVersion,
  getNamedCatalogNames,
  getProjectRoot,
  getYamlText,
  parseCatalogDoc,
  parseCatalogRef,
  removeCatalogEntry,
  setCatalogEntry,
} from './catalogManager';
import { findDependency, parsePackageJsonDependencies } from './packageJsonParser';

const CUSTOM_PICK = '__custom__';

interface CatalogPickItem extends QuickPickItem {
  catalogName: string;
}

interface VersionPickItem extends QuickPickItem {
  version: string;
}

export function registerCommands(
  context: ExtensionContext,
  state: ExtensionState,
  provider: CatalogCodeLensProvider,
): void {
  context.subscriptions.push(
    commands.registerCommand('tomjs.pnpmCatalog.enable', async () => {
      await state.setEnabled(true);
      provider.refresh();
      window.showInformationMessage(i18n.t('pnpmCatalog.message.toggleEnabled'));
    }),
    commands.registerCommand('tomjs.pnpmCatalog.disable', async () => {
      await state.setEnabled(false);
      provider.refresh();
      window.showInformationMessage(i18n.t('pnpmCatalog.message.toggleDisabled'));
    }),
    commands.registerCommand('tomjs.pnpmCatalog.addToCatalog', (args: AddToCatalogArgs) => {
      return handleAddToCatalog(args, provider);
    }),
  );
}

async function handleAddToCatalog(
  raw: AddToCatalogArgs | undefined,
  provider: CatalogCodeLensProvider,
): Promise<void> {
  if (!raw)
    return;
  const args: AddToCatalogArgs = { action: 'add', catalog: 'default', version: '', ...raw };

  const uri = Uri.parse(args.uri);
  if (path.basename(uri.fsPath) !== 'package.json') {
    window.showErrorMessage(i18n.t('pnpmCatalog.error.notPackageJson'));
    return;
  }

  const document = await workspace.openTextDocument(uri);
  const dep = findDependency(parsePackageJsonDependencies(document.getText()), args.packageName);
  if (!dep)
    return;

  const projectRoot = getProjectRoot(uri);
  if (!projectRoot) {
    window.showErrorMessage(i18n.t('pnpmCatalog.error.noProjectRoot'));
    return;
  }

  // Always operate on the pnpm-workspace.yaml at the project root; nested
  // workspace files (e.g. template projects) are ignored.
  const yamlPath = `${projectRoot}/pnpm-workspace.yaml`;
  let yamlText = getYamlText(yamlPath);
  let isNewYaml = false;

  if (yamlText === undefined) {
    if (args.action === 'remove') {
      // Nothing to restore from when the workspace file does not exist.
      window.showWarningMessage(i18n.t('pnpmCatalog.error.workspaceYaml', projectRoot));
      return;
    }

    // Ask before creating pnpm-workspace.yaml in the project root.
    const create = i18n.t('pnpmCatalog.confirm.create');
    const answer = await window.showInformationMessage(
      i18n.t('pnpmCatalog.confirm.createYaml.title', projectRoot),
      { modal: true },
      create,
      i18n.t('pnpmCatalog.confirm.cancel'),
    );
    if (answer !== create)
      return;
    yamlText = '';
    isNewYaml = true;
  }

  const yamlDoc = parseCatalogDoc(yamlText);
  if (yamlDoc.errors.length > 0) {
    window.showErrorMessage(i18n.t('pnpmCatalog.error.parseYaml', yamlDoc.errors[0].message));
    return;
  }

  let catalog = args.catalog;
  if (args.action === 'other') {
    const picked = await pickCatalogName(yamlDoc, args.packageName);
    if (picked === undefined)
      return;
    catalog = picked;
  }

  if (args.action === 'remove') {
    await restoreFromCatalog(uri, yamlPath, yamlText, yamlDoc, document, dep, catalog, provider);
    return;
  }

  // When the dependency already references a catalog, resolve the real version
  // from the source catalog. For orphan references (no catalog entry) ask for
  // the version instead of failing - the entry can then be created.
  let version = args.version;
  const currentRef = parseCatalogRef(dep.version);
  if (currentRef) {
    const sourceVersion = getCatalogVersion(yamlDoc, currentRef.catalogName, dep.name);
    if (sourceVersion === undefined) {
      const asked = await askForVersion(uri, dep.name);
      if (asked === undefined)
        return;
      version = asked;
    }
    else {
      version = sourceVersion;
    }
  }

  await addToCatalog(uri, yamlPath, yamlText, yamlDoc, document, dep, catalog, version, isNewYaml, provider);
}

/** Asks for a version, pre-filling the one installed in node_modules. */
async function askForVersion(uri: Uri, packageName: string): Promise<string | undefined> {
  const installed = findInstalledVersion(path.dirname(uri.fsPath), packageName);
  const value = await window.showInputBox({
    title: i18n.t('pnpmCatalog.input.version.title', packageName),
    prompt: i18n.t('pnpmCatalog.input.version.prompt'),
    placeHolder: i18n.t('pnpmCatalog.input.version.placeholder'),
    value: installed,
    valueSelection: installed ? [0, installed.length] : undefined,
    validateInput: v => (v.trim() ? undefined : i18n.t('pnpmCatalog.input.version.empty')),
  });
  return value?.trim() || undefined;
}

async function addToCatalog(
  uri: Uri,
  yamlPath: string,
  yamlText: string,
  yamlDoc: ReturnType<typeof parseCatalogDoc>,
  document: TextDocument,
  dep: ParsedDependency,
  catalog: string,
  version: string,
  isNewYaml: boolean,
  provider: CatalogCodeLensProvider,
): Promise<void> {
  const targetProtocol = catalogProtocol(catalog);
  const existing = getCatalogVersion(yamlDoc, catalog, dep.name);

  if (existing !== undefined && existing !== version) {
    const chosen = await pickVersionConflict(dep.name, catalog, existing, version);
    if (chosen === undefined)
      return;
    version = chosen;
  }

  // Nothing to change: the dependency already points at this catalog with the same version.
  if (existing === version && dep.version === targetProtocol)
    return;

  const edit = new WorkspaceEdit();
  if (isNewYaml) {
    edit.createFile(Uri.file(yamlPath), { overwrite: true });
  }
  if (existing !== version) {
    setCatalogEntry(yamlDoc, catalog, dep.name, version);
    applyCatalogStyle(yamlDoc, catalog);
    edit.replace(Uri.file(yamlPath), fullRange(yamlText), yamlDoc.toString());
  }
  if (dep.version !== targetProtocol) {
    edit.replace(uri, versionRangeOf(document, dep), targetProtocol);
  }
  if (edit.size > 0) {
    const applied = await workspace.applyEdit(edit);
    if (!applied) {
      window.showErrorMessage(i18n.t('pnpmCatalog.error.applyEdit'));
      return;
    }
    // WorkspaceEdit only updates the buffer of open documents - persist them.
    await saveIfOpen(uri);
    await saveIfOpen(Uri.file(yamlPath));
  }
  provider.refresh();

  if (existing !== undefined) {
    window.showInformationMessage(i18n.t('pnpmCatalog.message.updated', dep.name, version, catalog));
  }
  else {
    window.showInformationMessage(i18n.t('pnpmCatalog.message.added', dep.name, version, catalog));
  }
}

async function restoreFromCatalog(
  uri: Uri,
  yamlPath: string,
  yamlText: string,
  yamlDoc: ReturnType<typeof parseCatalogDoc>,
  document: TextDocument,
  dep: ParsedDependency,
  catalog: string,
  provider: CatalogCodeLensProvider,
): Promise<void> {
  const stored = getCatalogVersion(yamlDoc, catalog, dep.name);
  if (stored === undefined) {
    window.showWarningMessage(i18n.t('pnpmCatalog.error.notInCatalog', dep.name, catalog));
    return;
  }

  const edit = new WorkspaceEdit();
  removeCatalogEntry(yamlDoc, catalog, dep.name);
  edit.replace(Uri.file(yamlPath), fullRange(yamlText), yamlDoc.toString());
  edit.replace(uri, versionRangeOf(document, dep), stored);
  const applied = await workspace.applyEdit(edit);
  if (!applied) {
    window.showErrorMessage(i18n.t('pnpmCatalog.error.applyEdit'));
    return;
  }
  await saveIfOpen(uri);
  await saveIfOpen(Uri.file(yamlPath));
  provider.refresh();

  window.showInformationMessage(i18n.t('pnpmCatalog.message.removed', dep.name));
}

/** Saves an open document so its buffer is written to disk; closed files were already written by the edit. */
async function saveIfOpen(uri: Uri): Promise<void> {
  const doc = workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
  await doc?.save();
}

async function pickCatalogName(
  yamlDoc: ReturnType<typeof parseCatalogDoc>,
  packageName: string,
): Promise<string | undefined> {
  const reserved = new Set(reservedCatalogNames());
  const items: CatalogPickItem[] = [
    { label: i18n.t('pnpmCatalog.pick.custom'), catalogName: CUSTOM_PICK },
  ];
  for (const name of getNamedCatalogNames(yamlDoc)) {
    if (reserved.has(name))
      continue;
    const existing = getCatalogVersion(yamlDoc, name, packageName);
    items.push({
      label: existing
        ? i18n.t('pnpmCatalog.pick.hasVersion', name, existing)
        : name,
      catalogName: name,
    });
  }

  const selected = await window.showQuickPick(items, {
    title: i18n.t('pnpmCatalog.pick.title'),
  });
  if (!selected)
    return undefined;

  if (selected.catalogName !== CUSTOM_PICK)
    return selected.catalogName;

  const name = await window.showInputBox({
    title: i18n.t('pnpmCatalog.input.name.prompt'),
    placeHolder: i18n.t('pnpmCatalog.input.name.placeholder'),
    validateInput: value => validateCatalogName(value, yamlDoc),
  });
  if (name === undefined)
    return undefined;
  return name.trim();
}

function validateCatalogName(
  value: string,
  yamlDoc: ReturnType<typeof parseCatalogDoc>,
): string | undefined {
  const name = value.trim();
  if (!name)
    return i18n.t('pnpmCatalog.input.name.empty');
  const reserved = new Set(reservedCatalogNames());
  if (reserved.has(name))
    return i18n.t('pnpmCatalog.input.name.reserved', name);
  if (!/^[\w.-]+$/.test(name))
    return i18n.t('pnpmCatalog.input.name.invalid');
  if (getNamedCatalogNames(yamlDoc).includes(name)) {
    return i18n.t('pnpmCatalog.input.name.exists', name);
  }
  return undefined;
}

async function pickVersionConflict(
  packageName: string,
  catalog: string,
  existing: string,
  current: string,
): Promise<string | undefined> {
  const items: VersionPickItem[] = [
    { label: i18n.t('pnpmCatalog.conflict.catalog', existing), version: existing },
    { label: i18n.t('pnpmCatalog.conflict.package', current), version: current },
  ];
  const selected = await window.showQuickPick(items, {
    title: i18n.t('pnpmCatalog.conflict.title', packageName, catalog),
  });
  return selected?.version;
}

function versionRangeOf(document: TextDocument, dep: ParsedDependency): Range {
  return new Range(
    document.positionAt(dep.versionStart),
    document.positionAt(dep.versionEnd),
  );
}

/** Builds a range covering an entire document from its raw text. */
function fullRange(text: string): Range {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return new Range(0, 0, last, lines[last].length);
}
