import type { Uri } from 'vscode';
import type { Document, Pair } from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { workspace } from 'vscode';
import { parseDocument, Scalar, YAMLMap } from 'yaml';

/** Name used for the top-level `catalog:` key. */
export const DEFAULT_CATALOG = 'default';
/** Named catalogs that get a dedicated context-aware CodeLens button. */
export const BUILTIN_CATALOGS = ['dev', 'prod', 'peer', 'optional'];

/**
 * Looks up the installed version of a package in node_modules, searching
 * upward from `startDir` (pnpm symlinks resolve to the real package.json).
 */
export function findInstalledVersion(startDir: string, packageName: string): string | undefined {
  let dir = startDir;
  for (;;) {
    try {
      const pkgPath = path.join(dir, 'node_modules', ...packageName.split('/'), 'package.json');
      const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
      if (typeof version === 'string' && version)
        return version;
    }
    catch {
      // not found here - keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      return undefined;
    dir = parent;
  }
}

/**
 * Returns the project root (VS Code workspace folder) containing the uri.
 * Uses the VS Code workspace API so multi-root workspaces resolve correctly.
 * Nested pnpm-workspace.yaml files (e.g. template projects) are deliberately
 * ignored - only the file at the workspace root is used.
 */
export function getProjectRoot(uri: Uri): string | undefined {
  return workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

/** Reads file text, preferring the open editor document so unsaved edits are kept. */
export function getYamlText(filePath: string): string | undefined {
  const doc = workspace.textDocuments.find(d => d.uri.fsPath === filePath);
  if (doc)
    return doc.getText();
  if (!fs.existsSync(filePath))
    return undefined;
  return fs.readFileSync(filePath, 'utf8');
}

/** Parses YAML text into a reusable document that preserves comments/formatting. */
export function parseCatalogDoc(text: string): Document {
  return parseDocument(text);
}

/** Returns the catalog reference protocol, e.g. `catalog:` or `catalog:dev`. */
export function catalogProtocol(catalogName: string): string {
  return catalogName === DEFAULT_CATALOG ? 'catalog:' : `catalog:${catalogName}`;
}

/** Parses a `catalog:` / `catalog:name` version reference. */
export function parseCatalogRef(
  version: string,
): { catalogName: string } | undefined {
  const match = /^catalog:(.*)$/.exec(version);
  if (!match)
    return undefined;
  return { catalogName: match[1] || DEFAULT_CATALOG };
}

/** Extracts all catalogs as catalogName -> (packageName -> version). */
export function getCatalogVersions(doc: Document): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const js = doc.toJS() as Record<string, any> | undefined;
  if (!js)
    return result;

  if (js.catalog && typeof js.catalog === 'object') {
    result.set(DEFAULT_CATALOG, entriesToMap(js.catalog));
  }
  if (js.catalogs && typeof js.catalogs === 'object') {
    for (const [name, entries] of Object.entries(js.catalogs as Record<string, any>)) {
      if (entries && typeof entries === 'object') {
        result.set(name, entriesToMap(entries));
      }
    }
  }
  return result;
}

function entriesToMap(entries: Record<string, any>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      map.set(key, String(value));
    }
  }
  return map;
}

/** Returns the version stored in a catalog for a package, if any. */
export function getCatalogVersion(
  doc: Document,
  catalogName: string,
  packageName: string,
): string | undefined {
  const path = catalogPath(catalogName, packageName);
  const value = doc.getIn(path);
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  return undefined;
}

/** Returns the names of all named catalogs (under `catalogs:`), excluding default. */
export function getNamedCatalogNames(doc: Document): string[] {
  const js = doc.toJS() as Record<string, any> | undefined;
  if (!js?.catalogs || typeof js.catalogs !== 'object')
    return [];
  return Object.keys(js.catalogs);
}

/** Sets (or overwrites) a catalog entry. */
export function setCatalogEntry(
  doc: Document,
  catalogName: string,
  packageName: string,
  version: string,
): void {
  doc.setIn(catalogPath(catalogName, packageName), version);
}

/**
 * Applies blank-line separation between catalog blocks (pnpm docs style) without
 * touching existing content: a blank line between the default `catalog:` block
 * and `catalogs:`, and before every named catalog other than the first.
 * No comments are generated; existing comments are always preserved.
 */
export function applyCatalogStyle(doc: Document, catalogName: string): void {
  const rootItems = doc.contents instanceof YAMLMap ? doc.contents.items : undefined;
  if (!rootItems)
    return;

  const catalogsPair = rootItems.find(pair => keyText(pair.key) === 'catalogs');
  if (!catalogsPair)
    return;

  // Blank line between the default `catalog:` block and `catalogs:`.
  const hasDefault = rootItems.some(pair => keyText(pair.key) === 'catalog');
  const catalogsKey = useStyledScalar(catalogsPair);
  if (hasDefault && catalogsKey && !catalogsKey.commentBefore && !catalogsKey.spaceBefore)
    catalogsKey.spaceBefore = true;

  if (catalogName === DEFAULT_CATALOG)
    return;

  const catalogItems = catalogsPair.value instanceof YAMLMap ? catalogsPair.value.items : undefined;
  if (!catalogItems)
    return;

  const pair = catalogItems.find(item => keyText(item.key) === catalogName);
  if (!pair)
    return;
  const index = catalogItems.indexOf(pair);
  const key = useStyledScalar(pair);
  if (!key)
    return;

  if (index > 0 && !key.commentBefore && !key.spaceBefore)
    key.spaceBefore = true;
}

function keyText(key: unknown): string | undefined {
  if (typeof key === 'string')
    return key;
  if (key instanceof Scalar)
    return typeof key.value === 'string' ? key.value : undefined;
  // setIn() creates bare String objects for new keys
  if (typeof key === 'object' && key !== null)
    return String(key);
  return undefined;
}

/**
 * setIn() creates bare String keys that cannot carry comments or spacing.
 * Swaps them for real Scalar nodes so `commentBefore`/`spaceBefore` serialize.
 */
function useStyledScalar(pair: Pair): Scalar | undefined {
  if (pair.key instanceof Scalar)
    return pair.key;
  const text = keyText(pair.key);
  if (text === undefined)
    return undefined;
  const scalar = new Scalar(text);
  pair.key = scalar;
  return scalar;
}

/** Removes a catalog entry. */
export function removeCatalogEntry(
  doc: Document,
  catalogName: string,
  packageName: string,
): void {
  doc.deleteIn(catalogPath(catalogName, packageName));
}

function catalogPath(catalogName: string, packageName: string): string[] {
  return catalogName === DEFAULT_CATALOG
    ? ['catalog', packageName]
    : ['catalogs', catalogName, packageName];
}
