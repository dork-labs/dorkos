import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** The repo root, so the test reads the same files from any working directory. */
const ROOT = path.resolve(import.meta.dirname, '../..');

// A whole-repo scan, sized like its sibling gray-matter-import-boundary.test.ts.
vi.setConfig({ testTimeout: 15_000 });

/**
 * "Shared" means more than one side reads it (DOR-4931). Every subpath in the
 * `exports` map of `packages/shared/package.json` must earn its place twice:
 *
 * 1. Something outside `packages/shared` imports it. A key nobody imports is
 *    surface with no reader; drop the key, and the module stays internal if a
 *    sibling still uses it.
 * 2. Something other than the server imports it. A key only `apps/server`
 *    reads is server code living in the wrong package: move it under
 *    `apps/server/src` (its domain's folder, or `lib/` when two domains share
 *    it). A key that has to stay anyway is listed in {@link SERVER_ONLY_KEYS}
 *    with the reason.
 *
 * An importer is an import or export `from`, a dynamic `import()`, a
 * `require()`, or a `vi.mock`-family call, in tracked source outside
 * `packages/shared`, of `@dorkos/shared/<key>` or of the key's module by a
 * relative path (scripts run without a build, so they import
 * `packages/shared/src/<key>.ts` directly). A mention in a comment or a doc
 * is not one.
 */

/**
 * Keys no file imports by name, kept so TypeScript can name the types other exports
 * return: a declaration emitted for an inferred return type must reach them (TS2742).
 */
const TYPE_ONLY_KEYS: Record<string, string> = {
  'bounded-json':
    'Its JSON types appear in what the transport and doc-channel helpers return, so the client and e2e need it to name those types (TS2742).',
};

/** Server-only keys that stay in `@dorkos/shared`, each with the reason. */
const SERVER_ONLY_KEYS: Record<string, string> = {
  'community-administer':
    'Community wire, frozen until the Community Space opens (AGENTS.md, "Where the system is going", rule 4).',
  'community-private-wire':
    'Community wire, frozen until the Community Space opens (AGENTS.md, "Where the system is going", rule 4).',
  'running-chats':
    "Shared's own agent-runtime (read by the client) imports its SessionCapacity type.",
  'browser-schemas': "Shared's own browser-frame-wire (read by the client) imports its schemas.",
  'session-relay':
    "A contract, so it stays in shared for good: the link between a person's cloud DorkOS and their Mac (the item 13 spec). Shared's own session-relay-link, which the client reads, imports it too.",
  'session-relay-agent-computer':
    'A contract, so it stays in shared for good: the wire between a home and its agent computers (spec space-computer-contract, DOR-5164). Both ends live in the server today; the contract is what lets them run on two machines.',
  'wire/features':
    'A contract, so it stays in shared for good: the feature ids both ends of the computer wire agree on (spec space-computer-contract §4.1, DOR-5164). Both ends live in the server today; the contract is what lets them run on two machines.',
  'turn-port':
    'A contract, so it stays in shared for good: the one between the space side and the computer side (ADR 261124-150516). Both live in the server today; the contract is what lets them part.',
  'entity-ref':
    'A pure reference parser, so it stays in shared for good: other workspaces import it from here (the work graph), and @dorkos/db stores the same spelling.',
  'room-export-schemas':
    "It teaches zod .openapi() through shared's internal zod-openapi, the one place that repair lives.",
  'directory-grants':
    'It defaults the home folder to os.homedir(), which the server bans outside its listed carve-outs (.claude/rules/dork-home.md).',
  'runtime-connect-schemas':
    "Shared's own runtime-connect (read by the client) re-exports its types, and it teaches zod .openapi() through shared's internal zod-openapi.",
  'chat-client-id':
    'A shared home between the space side and the computer side of the computer wall (step 6, DOR-5303/DOR-5403); both sides live in the server today.',
  'room-attachment-paths':
    'A shared home between the space side and the computer side of the computer wall (step 6, DOR-5303/DOR-5403); both sides live in the server today.',
  'connections-lease':
    'A shared home between the space side and the computer side of the computer wall (step 6, DOR-5303/DOR-5403); both sides live in the server today.',
  'computer-asks':
    'The asks port between the space side and the computer side (C14, DOR-5459); both sides live in the server today.',
  'agent-facts':
    'The agent facts port between the space side and the computer side (C18, DOR-5462); both sides live in the server today.',
  'approval-text':
    'The asks port between the space side and the computer side (C14, DOR-5459); both sides live in the server today.',
  'consent-entries':
    'The asks port between the space side and the computer side (C14, DOR-5459); both sides live in the server today.',
  'folder-allows-card':
    'The asks port between the space side and the computer side (C14, DOR-5459); both sides live in the server today.',
};

/**
 * Every `@dorkos/shared/<key>` a source file imports, mocks or requires.
 *
 * @param source - The file's text.
 */
export function importedSharedKeys(source: string): string[] {
  const pattern =
    /(?:\bfrom\s*|\bimport\s+|\b(?:import|require|mock|doMock|unmock|importActual|importMock|resolve)\s*\(\s*)(['"`])(?:@dorkos\/shared\/|(?:\.\.?\/)+(?:[\w.-]+\/)*packages\/shared\/src\/)([A-Za-z0-9_./-]+?)(?:\/index)?(?:\.[jt]s)?\1/g;
  return [...source.matchAll(pattern)].flatMap((match) => (match[2] ? [match[2]] : []));
}

/** The export keys, without their leading `./`. */
function exportKeys(): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'packages/shared/package.json'), 'utf8')
  ) as {
    exports: Record<string, unknown>;
  };
  return Object.keys(manifest.exports).map((key) => key.replace(/^\.\//, ''));
}

/** Each key to the tracked source files outside `packages/shared` that import it. */
function importersByKey(keys: readonly string[]): Map<string, string[]> {
  const files = execFileSync(
    'git',
    ['ls-files', '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.mts', '*.cts'],
    // The repo lists well over 1 MB of paths, the default buffer.
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .trim()
    .split('\n')
    .filter(
      (file) =>
        file.length > 0 && !file.startsWith('packages/shared/') && existsSync(path.join(ROOT, file))
    );
  const importers = new Map(keys.map((key) => [key, [] as string[]]));
  for (const file of files) {
    for (const key of importedSharedKeys(readFileSync(path.join(ROOT, file), 'utf8')))
      importers.get(key)?.push(file);
  }
  return importers;
}

/**
 * The broken rules, as readable lines.
 *
 * @param importers - Each key to the files outside the package that import it.
 * @param serverOnly - The keys allowed to have only server importers.
 */
export function exportFindings(
  importers: ReadonlyMap<string, readonly string[]>,
  serverOnly: Readonly<Record<string, string>>,
  typeOnly: Readonly<Record<string, string>> = {}
): string[] {
  const findings: string[] = [];
  for (const [key, files] of importers) {
    const outsideServer = files.filter((file) => !file.startsWith('apps/server/'));
    if (files.length === 0 && key in typeOnly) continue;
    if (files.length === 0) findings.push(`${key}: no importer outside packages/shared`);
    else if (outsideServer.length === 0 && !(key in serverOnly))
      findings.push(`${key}: only apps/server imports it`);
    else if (outsideServer.length > 0 && key in serverOnly)
      findings.push(`${key}: listed as server-only, but ${outsideServer[0]} imports it`);
  }
  for (const key of Object.keys(serverOnly))
    if (!importers.has(key)) findings.push(`${key}: listed as server-only, but no such export`);
  for (const key of Object.keys(typeOnly))
    if (!importers.has(key)) findings.push(`${key}: listed as type-only, but no such export`);
  return findings;
}

describe('@dorkos/shared export keys (DOR-4931)', () => {
  it('every key has an importer outside the package, and one besides the server', () => {
    const keys = exportKeys();
    expect(keys.length).toBeGreaterThan(100);
    expect(exportFindings(importersByKey(keys), SERVER_ONLY_KEYS, TYPE_ONLY_KEYS)).toEqual([]);
  });

  it('recognises each import spelling and ignores prose', () => {
    expect(importedSharedKeys("import { a } from '@dorkos/shared/schemas';")).toEqual(['schemas']);
    expect(importedSharedKeys('import type { A } from "@dorkos/shared/types";')).toEqual(['types']);
    expect(importedSharedKeys("export * from '@dorkos/shared/permissions';")).toEqual([
      'permissions',
    ]);
    expect(importedSharedKeys("await import('@dorkos/shared/space-page');")).toEqual([
      'space-page',
    ]);
    // Split so check:own-mocks does not read this line as a mock of our own module.
    const viDot = ['vi', ''].join('.');
    expect(importedSharedKeys(`${viDot}mock('@dorkos/shared/logger', () => ({}));`)).toEqual([
      'logger',
    ]);
    expect(importedSharedKeys(`await ${viDot}importActual('@dorkos/shared/cron');`)).toEqual([
      'cron',
    ]);
    expect(importedSharedKeys("import '@dorkos/shared/zod-setup.js';")).toEqual(['zod-setup']);
    expect(importedSharedKeys("import x from '@dorkos/shared/prompts/kinds';")).toEqual([
      'prompts/kinds',
    ]);
    expect(
      importedSharedKeys("import { x } from '../../packages/shared/src/provenance.js';")
    ).toEqual(['provenance']);
    expect(
      importedSharedKeys("import { y } from '../packages/shared/src/space-page/index.ts';")
    ).toEqual(['space-page']);
    expect(importedSharedKeys(' * reached as (`@dorkos/shared/doc-title`) in prose')).toEqual([]);
  });

  it('fails a key with no importer, a server-only key and a stale allowance', () => {
    const importers = new Map<string, string[]>([
      ['unread', []],
      ['server-only', ['apps/server/src/a.ts']],
      ['both', ['apps/server/src/a.ts', 'apps/client/src/b.ts']],
      ['allowed', ['apps/server/src/a.ts']],
      ['stale', ['apps/server/src/a.ts', 'packages/cli/src/c.ts']],
    ]);
    expect(exportFindings(importers, { allowed: 'why', stale: 'why', gone: 'why' })).toEqual([
      'unread: no importer outside packages/shared',
      'server-only: only apps/server imports it',
      'stale: listed as server-only, but packages/cli/src/c.ts imports it',
      'gone: listed as server-only, but no such export',
    ]);
  });
});
