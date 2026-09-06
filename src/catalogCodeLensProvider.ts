import type { CodeLensProvider, TextDocument } from 'vscode';
import type { ExtensionState } from './extensionState';
import type { DependencySection, ParsedDependency } from './packageJsonParser';
import * as path from 'node:path';
import { i18n } from '@tomjs/vscode';
import {
  CodeLens,

  EventEmitter,
  Range,

} from 'vscode';
import {
  BUILTIN_CATALOGS,
  DEFAULT_CATALOG,
  parseCatalogRef,
} from './catalogManager';
import {

  isAddableVersion,

  parsePackageJsonDependencies,
} from './packageJsonParser';

/** Maps a dependency section to its built-in named catalog. */
const SECTION_CATALOG: Record<DependencySection, string> = {
  dependencies: 'prod',
  devDependencies: 'dev',
  peerDependencies: 'peer',
  optionalDependencies: 'optional',
};

export interface AddToCatalogArgs {
  uri: string;
  action: 'add' | 'remove' | 'other';
  catalog: string;
  packageName: string;
  version: string;
}

interface GroupedDependency {
  name: string;
  version: string;
  nameStart: number;
  sections: DependencySection[];
}

export class CatalogCodeLensProvider implements CodeLensProvider {
  private readonly emitter = new EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.emitter.event;

  private readonly state: ExtensionState;

  constructor(state: ExtensionState) {
    this.state = state;
  }

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: TextDocument): CodeLens[] {
    if (!this.state.enabled)
      return [];
    if (path.basename(document.uri.fsPath) !== 'package.json')
      return [];

    const groups = groupDependencies(parsePackageJsonDependencies(document.getText()));
    const lenses: CodeLens[] = [];

    for (const dep of groups) {
      const currentRef = parseCatalogRef(dep.version);
      const supported = Boolean(currentRef) || isAddableVersion(dep.version);
      if (!supported)
        continue;

      // All buttons share the dependency name position; VS Code stacks
      // lenses that start on the same line side by side.
      const position = dep.nameStart;

      lenses.push(this.makeButton(document, position, dep, DEFAULT_CATALOG, currentRef?.catalogName));

      for (const section of dep.sections) {
        lenses.push(this.makeButton(document, position, dep, SECTION_CATALOG[section], currentRef?.catalogName));
      }

      lenses.push(this.makeOtherButton(document, position, dep));

      if (currentRef) {
        lenses.push(this.makeRemoveButton(document, position, dep, currentRef.catalogName));
      }
    }

    return lenses;
  }

  private makeButton(
    document: TextDocument,
    position: number,
    dep: GroupedDependency,
    catalogName: string,
    currentCatalog: string | undefined,
  ): CodeLens {
    const isCurrent = currentCatalog === catalogName;
    const prefix = isCurrent ? '\u2713 ' : '+';
    const title = `${prefix}${buttonLabel(catalogName)}`;
    return this.createLens(document, position, title, {
      uri: document.uri.toString(),
      action: 'add',
      catalog: catalogName,
      packageName: dep.name,
      version: dep.version,
    });
  }

  private makeOtherButton(document: TextDocument, position: number, dep: GroupedDependency): CodeLens {
    const title = `+${i18n.t('pnpmCatalog.button.other')}`;
    return this.createLens(document, position, title, {
      uri: document.uri.toString(),
      action: 'other',
      catalog: DEFAULT_CATALOG,
      packageName: dep.name,
      version: dep.version,
    });
  }

  private makeRemoveButton(
    document: TextDocument,
    position: number,
    dep: GroupedDependency,
    catalogName: string,
  ): CodeLens {
    return this.createLens(document, position, i18n.t('pnpmCatalog.button.remove'), {
      uri: document.uri.toString(),
      action: 'remove',
      catalog: catalogName,
      packageName: dep.name,
      version: dep.version,
    });
  }

  private createLens(
    document: TextDocument,
    position: number,
    title: string,
    args: AddToCatalogArgs,
  ): CodeLens {
    const lensPosition = document.positionAt(position);
    const lens = new CodeLens(new Range(lensPosition, lensPosition));
    lens.command = {
      command: 'tomjs.pnpmCatalog.addToCatalog',
      title,
      arguments: [args],
    };
    return lens;
  }
}

function buttonLabel(catalogName: string): string {
  return catalogName === DEFAULT_CATALOG
    ? i18n.t('pnpmCatalog.button.default')
    : i18n.t('pnpmCatalog.button.named', catalogName);
}

function groupDependencies(deps: ParsedDependency[]): GroupedDependency[] {
  const groups = new Map<string, GroupedDependency>();
  for (const dep of deps) {
    let group = groups.get(dep.name);
    if (!group) {
      group = {
        name: dep.name,
        version: dep.version,
        nameStart: dep.nameStart,
        sections: [],
      };
      groups.set(dep.name, group);
    }
    group.sections.push(dep.section);
  }
  return [...groups.values()];
}

/** Catalog names that are reserved (default + built-ins) and excluded from the +catalogs:* picker. */
export function reservedCatalogNames(): string[] {
  return [DEFAULT_CATALOG, ...BUILTIN_CATALOGS];
}
