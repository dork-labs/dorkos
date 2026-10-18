/**
 * What the space image's entries import (server-merge step 7, DOR-3006). The image ships the
 * space server alone: never the machine store (SQLite), a runtime SDK or a terminal. Once the
 * space code lives inside the DorkOS server package those sit one import away, so this walks
 * each entry's whole import graph with esbuild and lists every outside package it reaches,
 * following workspace packages into their TypeScript source so one that drags SQLite in is seen.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build, type Plugin } from 'esbuild';

/** The repository root. */
export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname;

/** Packages the space image must never reach, with why. */
export const FORBIDDEN_IN_SPACE_IMAGE: Readonly<Record<string, string>> = {
  'better-sqlite3': 'the machine store',
  '@dorkos/db': 'the machine store',
  '@anthropic-ai/claude-agent-sdk': 'a runtime SDK',
  '@openai/codex-sdk': 'a runtime SDK',
  '@opencode-ai/sdk': 'a runtime SDK',
  'node-pty': 'the terminal',
};

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

/**
 * Every outside package an entry's import graph reaches, each with the first file that imports
 * it. Workspace packages are followed into their source and listed too.
 *
 * @param entry - The entry file, relative to the repository root.
 */
export async function packagesReachedFrom(entry: string): Promise<Map<string, string>> {
  const known = workspaces();
  const reached = new Map<string, string>();
  const walk: Plugin = {
    name: 'space-image-imports',
    setup(builder) {
      // esbuild reads the filter as a Go regular expression, which takes no `u` flag.
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith('node:')) return { external: true };
        const parts = args.path.split('/');
        const name = args.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!reached.has(name)) reached.set(name, relative(REPO_ROOT, args.importer));
        const workspace = known.get(name);
        if (!workspace) return { external: true };
        const file = resolveWorkspace(workspace, `.${args.path.slice(name.length)}`);
        if (!file) return { errors: [{ text: `${args.path} matches no export of ${name}` }] };
        return { path: join(workspace.dir, file) };
      });
    },
  };
  await build({
    entryPoints: [join(REPO_ROOT, entry)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [walk],
    // Assets a browser page imports never reach the server; read them as nothing.
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.node': 'empty' },
  });
  return reached;
}

/** The forbidden packages an entry reaches, each as "<package> (<why>), first from <file>". */
export async function forbiddenReachedFrom(entry: string): Promise<string[]> {
  const reached = await packagesReachedFrom(entry);
  return Object.entries(FORBIDDEN_IN_SPACE_IMAGE)
    .filter(([name]) => reached.has(name))
    .map(([name, why]) => `${name} (${why}), first from ${reached.get(name)}`);
}
