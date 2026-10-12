/**
 * The `spec-status-sync.sh` hook decides a spec's status from the same known
 * artifact names as `spec-manifest-ops.ts`, not from the highest `0N-` number
 * (DOR-2704). Writing `05-live-checklist.md` beside a specification used to flip
 * the manifest to `implemented` while the spec was still being checked.
 *
 * Runs the real hook against a throwaway git repo, the way Claude Code runs it:
 * a Write tool's JSON on stdin, the repo as the working directory.
 *
 * Run directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --test .claude/scripts/__tests__/spec-status-sync-hook.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', '..', 'hooks', 'spec-status-sync.sh');
const OPS = join(HERE, '..', 'spec-manifest-ops.ts');

/** A git repo with one spec, `specified` in the manifest, holding the given files. */
function sandbox(files: string[]): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'spec-status-sync-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', 'manifest.json'), JSON.stringify({ version: 1, specs: [] }));
  const node = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', OPS];
  execFileSync('node', [...node, 'add', 'demo', 'Demo', '--status=specified', '--quiet'], {
    cwd: root,
  });
  const dir = join(root, 'specs', 'demo');
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), `# ${f}\n`);
  return { root, dir };
}

/** Run the hook as if the Write tool had just written `file`, and read back the status. */
function writeAndRead(root: string, file: string): string {
  execFileSync('bash', [HOOK], {
    cwd: root,
    input: JSON.stringify({ tool_input: { file_path: file } }),
  });
  const manifest = JSON.parse(readFileSync(join(root, 'specs', 'manifest.json'), 'utf-8'));
  return manifest.specs.find((s: { slug: string }) => s.slug === 'demo').status;
}

test('02 + 05-live-checklist stays specified', () => {
  const { root, dir } = sandbox(['02-specification.md', '05-live-checklist.md']);
  try {
    assert.equal(writeAndRead(root, join(dir, '05-live-checklist.md')), 'specified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('04-acceptance.md does not promote either', () => {
  const { root, dir } = sandbox(['02-specification.md', '04-acceptance.md']);
  try {
    assert.equal(writeAndRead(root, join(dir, '04-acceptance.md')), 'specified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('04-implementation.md still advances to implemented', () => {
  const { root, dir } = sandbox(['02-specification.md', '04-implementation.md']);
  try {
    assert.equal(writeAndRead(root, join(dir, '04-implementation.md')), 'implemented');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
