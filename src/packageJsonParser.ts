import type { Node, ParseError } from 'jsonc-parser';
import { parseTree } from 'jsonc-parser';

export type DependencySection
  = | 'dependencies'
    | 'devDependencies'
    | 'peerDependencies'
    | 'optionalDependencies';

export interface ParsedDependency {
  /** The dependency section the package belongs to. */
  section: DependencySection;
  /** Package name (including `@scope/` prefix if any). */
  name: string;
  /** The version range as written in package.json. */
  version: string;
  /** Character offsets of the unquoted package name in the document. */
  nameStart: number;
  nameEnd: number;
  /** Character offsets of the unquoted version value in the document. */
  versionStart: number;
  versionEnd: number;
}

const SECTION_KEYS: DependencySection[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Protocols that reference non-registry sources and cannot be stored in a catalog. */
const PROTOCOL_RE = /^(?:catalog|workspace|file|link|portal|git|github|gitlab|bitbucket|npm|http|https):/i;

/** True when a version range can be moved into a pnpm catalog. */
export function isAddableVersion(version: string | undefined): boolean {
  if (!version)
    return false;
  return !PROTOCOL_RE.test(version);
}

function propertyValue(node: Node | undefined, key: string): Node | undefined {
  if (!node?.children)
    return undefined;
  const prop = node.children.find(
    child => child.type === 'property' && child.children?.[0]?.value === key,
  );
  return prop?.children?.[1];
}

/**
 * Parses package.json text and returns every dependency with the document
 * offsets of its unquoted name and version value.
 * Returns an empty array when the JSON cannot be parsed.
 */
export function parsePackageJsonDependencies(text: string): ParsedDependency[] {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors);
  if (!root || errors.length > 0)
    return [];

  const result: ParsedDependency[] = [];
  for (const section of SECTION_KEYS) {
    const sectionNode = propertyValue(root, section);
    if (!sectionNode || sectionNode.type !== 'object')
      continue;

    for (const prop of sectionNode.children ?? []) {
      if (prop.type !== 'property' || !prop.children)
        continue;
      const keyNode = prop.children[0];
      const valueNode = prop.children[1];
      if (!keyNode || !valueNode || valueNode.type !== 'string')
        continue;

      result.push({
        section,
        name: keyNode.value as string,
        version: valueNode.value as string,
        nameStart: keyNode.offset + 1,
        nameEnd: keyNode.offset + keyNode.length - 1,
        versionStart: valueNode.offset + 1,
        versionEnd: valueNode.offset + valueNode.length - 1,
      });
    }
  }
  return result;
}

/** Finds the parsed dependency for a package name across all sections. */
export function findDependency(
  dependencies: ParsedDependency[],
  name: string,
): ParsedDependency | undefined {
  return dependencies.find(dep => dep.name === name);
}
