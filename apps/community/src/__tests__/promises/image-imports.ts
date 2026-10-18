/**
 * What the space image's entries import (server-merge step 7, DOR-3006). The image ships the
 * space server alone: never the machine store (SQLite), a runtime SDK or a terminal. Once the
 * space code lives inside the DorkOS server package those sit one import away, so this walks
 * each entry's whole import graph with esbuild and lists every outside package it reaches,
 * following workspace packages into their TypeScript source so one that drags SQLite in is seen.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { build, type Plugin } from 'esbuild';

/** The repository root. */
export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname;

/**
 * What the space image must never import, with why. An import matches when it names one of these
 * or reaches one through a subpath of another package, such as `drizzle-orm/better-sqlite3`.
 */
export const FORBIDDEN_IN_SPACE_IMAGE: Readonly<Record<string, string>> = {
  'better-sqlite3': 'the machine store',
  '@dorkos/db': 'the machine store',
  '@anthropic-ai/claude-agent-sdk': 'a runtime SDK',
  '@openai/codex-sdk': 'a runtime SDK',
  '@opencode-ai/sdk': 'a runtime SDK',
  'node-pty': 'the terminal',
  // Finds node-pty at run time through `createRequire`, which no import walk can see.
  '@dorkos/shared/node-pty-spawn-helper': 'the terminal',
};

/**
 * Files on the walk allowed to load code by a name the walk cannot read, with what they load.
 * Anything else that does is refused: a computed `import()` or a `createRequire` could load a
 * forbidden package unseen.
 */
export const DYNAMIC_LOADS_ALLOWED: Readonly<Record<string, string>> = {
  'apps/community/src/takedown/evidence/record.ts': "the space package's own package.json",
};

const forbids = (specifier: string, name: string) => `/${specifier}/`.includes(`/${name}/`);
const BUILTINS = new Set(builtinModules);
const DYNAMIC_LOAD = /\bcreateRequire\s*\(|\bimport\(\s*[^'"\s)]/u;

interface Workspace {
  dir: string;
  exports?: unknown;
  main?: string;
  types?: string;
}

function workspaces(): Map<string, Workspace> {
  const found = new Map<string, Workspace>();
  for (const top of ['packages', 'apps'])
    for (const name of readdirSync(join(REPO_ROOT, top))) {
      const manifest = join(REPO_ROOT, top, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as Workspace & { name: string };
      found.set(json.name, { ...json, dir: join(REPO_ROOT, top, name) });
    }
  return found;
}

const isSource = (path: unknown): path is string =>
  typeof path === 'string' && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts');

/** The file an export condition object points to, preferring TypeScript source over a build. */
function entryOf(condition: unknown): string | null {
  if (typeof condition === 'string') return condition;
  if (!condition || typeof condition !== 'object') return null;
  const conditions = condition as Record<string, unknown>;
  if (isSource(conditions.types)) return conditions.types;
  return entryOf(conditions.import ?? conditions.default ?? conditions.node);
}

/** The file a workspace import resolves to, in source; null when its exports have no match. */
function resolveWorkspace(workspace: Workspace, subpath: string): string | null {
  const { exports } = workspace;
  if (!exports)
    return subpath === '.'
      ? isSource(workspace.types)
        ? workspace.types
        : (workspace.main ?? null)
      : null;
  if (typeof exports === 'string') return subpath === '.' ? exports : null;
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((key) => key.startsWith('.')))
    return subpath === '.' ? entryOf(map) : null;
  if (subpath in map) return entryOf(map[subpath]);
  for (const [pattern, condition] of Object.entries(map)) {
    const [head, tail = ''] = pattern.split('*');
    if (pattern.includes('*') && subpath.startsWith(head) && subpath.endsWith(tail))
      return (
        entryOf(condition)?.replace(
          '*',
          subpath.slice(head.length, subpath.length - tail.length)
        ) ?? null
      );
  }
  return null;
}

/** What one walk found. */
export interface ImageImports {
  /** Every import of a package, by its full specifier, with the first file that has it. */
  specifiers: Map<string, string>;
  /** Every package reached, workspace packages included, with the first file that imports it. */
  packages: Map<string, string>;
  /** Walked repository files that load code by a computed name, outside the allowed list. */
  dynamicLoads: string[];
}

/**
 * Walk an entry's whole import graph. Workspace packages are followed into their source.
 *
 * @param entry - The entry file (absolute, or relative to the repository root), or source text
 *   to walk as if it were a file in the repository root.
 */
export async function walkImports(entry: string | { contents: string }): Promise<ImageImports> {
  const known = workspaces();
  const specifiers = new Map<string, string>();
  const packages = new Map<string, string>();
  const walk: Plugin = {
    name: 'space-image-imports',
    setup(builder) {
      // esbuild reads the filter as a Go regular expression, which takes no `u` flag.
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith('node:') || BUILTINS.has(args.path)) return { external: true };
        const parts = args.path.split('/');
        const name = args.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        // Source text walked as a file has a placeholder for a path, such as `<stdin>`.
        const importer = args.importer.startsWith('<')
          ? args.importer
          : relative(REPO_ROOT, args.importer);
        if (!specifiers.has(args.path)) specifiers.set(args.path, importer);
        if (!packages.has(name)) packages.set(name, importer);
        const workspace = known.get(name);
        if (!workspace) return { external: true };
        const file = resolveWorkspace(workspace, `.${args.path.slice(name.length)}`);
        if (!file) return { errors: [{ text: `${args.path} matches no export of ${name}` }] };
        return { path: join(workspace.dir, file) };
      });
    },
  };
  const result = await build({
    ...(typeof entry === 'string'
      ? { entryPoints: [isAbsolute(entry) ? entry : join(REPO_ROOT, entry)] }
      : { stdin: { contents: entry.contents, resolveDir: REPO_ROOT, loader: 'ts' as const } }),
    metafile: true,
    absWorkingDir: REPO_ROOT,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [walk],
    // Assets a browser page imports never reach the server; read them as nothing.
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.node': 'empty' },
  });
  const dynamicLoads = Object.keys(result.metafile.inputs)
    .filter((input) => !input.includes('node_modules/') && !input.startsWith('<'))
    .filter((file) => !Object.hasOwn(DYNAMIC_LOADS_ALLOWED, file))
    .filter((file) => DYNAMIC_LOAD.test(readFileSync(join(REPO_ROOT, file), 'utf8')));
  return { specifiers, packages, dynamicLoads };
}

/**
 * What an entry must not reach: each forbidden import as "<name> (<why>), first from <file>",
 * then each file that loads code by a computed name.
 *
 * @param entry - As for {@link walkImports}.
 */
export async function forbiddenReachedFrom(
  entry: string | { contents: string }
): Promise<string[]> {
  const { specifiers, dynamicLoads } = await walkImports(entry);
  const found = Object.entries(FORBIDDEN_IN_SPACE_IMAGE).flatMap(([name, why]) => {
    const first = [...specifiers].find(([specifier]) => forbids(specifier, name));
    return first ? [`${name} (${why}), first from ${first[1]}`] : [];
  });
  return [...found, ...dynamicLoads.map((file) => `a load by a computed name in ${file}`)];
}
