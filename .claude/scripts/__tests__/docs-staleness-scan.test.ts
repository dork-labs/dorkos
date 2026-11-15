import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { missingPaths, removedExports, scan, staleSymbols } from '../docs-staleness-scan.mjs';

test('reports a missing explicit file, while live files and placeholders stay quiet', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-staleness-'));
  mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(root, 'packages', 'shared', 'live.ts'), 'export const Live = 1;');
  assert.deepEqual(
    missingPaths(
      [
        'Use `packages/shared/live.ts:12`.',
        'Use `packages/shared/gone.ts`.',
        'Sketch: `packages/shared/<name>.ts` or `packages/shared/*.ts`.',
        'Historical `packages/shared/retired.ts`. <!-- doc-allow-stale: history -->',
        'User config: `.claude/settings.local.json` and `.agents/flow/config.local.json`.',
      ].join('\n'),
      root
    ),
    [{ line: 2, kind: 'missing-path', reference: 'packages/shared/gone.ts' }]
  );
});

test('only removed exports absent from current code become stale symbol candidates', () => {
  const diff = [
    '-export async function RemovedApi() {}',
    '-export interface RenamedInPlace {}',
    '-export const StillUsedInternally = 1;',
    '+export function NewApi() {}',
    '-const PrivateHelper = 1;',
  ].join('\n');
  assert.deepEqual(
    [
      ...removedExports(diff, [
        'interface RenamedInPlace {}',
        'const StillUsedInternally = 1;',
        '// RemovedApi used to be here; use NewApi instead.',
      ]),
    ],
    ['RemovedApi']
  );
});

test('finds stale symbols in code examples without substring or historical-example noise', () => {
  assert.deepEqual(
    staleSymbols(
      'RemovedApi(); RemovedApi();\nRemovedApiWrapper();\nRemovedApi(); // doc-allow-stale: old API',
      new Set(['RemovedApi'])
    ),
    [{ line: 1, kind: 'removed-symbol', reference: 'RemovedApi' }]
  );
});

test('scans exports from a deleted source file and rejects an invalid revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-staleness-repo-'));
  const git = (args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  git(['init', '-q']);
  mkdirSync(join(root, 'apps'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'apps', 'gone.ts'), 'export function RemovedApi() {}\n');
  writeFileSync(join(root, 'docs', 'guide.mdx'), 'Call `RemovedApi()` from `apps/gone.ts`.\n');
  writeFileSync(join(root, 'docs', 'changelog-archive.mdx'), 'Historical `RemovedApi()`.\n');
  git(['add', '--', 'apps', 'docs']);
  git(['commit', '-qm', 'fixture']);
  unlinkSync(join(root, 'apps', 'gone.ts'));
  assert.equal(scan(root, { since: 'HEAD' }).documents, 1);
  assert.deepEqual(scan(root, { since: 'HEAD' }).findings, [
    { file: 'docs/guide.mdx', line: 1, kind: 'missing-path', reference: 'apps/gone.ts' },
    { file: 'docs/guide.mdx', line: 1, kind: 'removed-symbol', reference: 'RemovedApi' },
  ]);
  assert.throws(() => scan(root, { since: '--help' }), /must not start with a dash/);
});
