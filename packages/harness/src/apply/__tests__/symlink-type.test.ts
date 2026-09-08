/**
 * The symlink type the apply stage asks Windows for.
 *
 * POSIX ignores the third argument to `symlinkSync`; Windows does not. A
 * directory link created as `'file'` needs admin rights or Developer Mode and
 * fails with EPERM without them, which is the whole reason the engine passes a
 * type at all. The decision therefore has to FOLLOW the source: a skill source
 * that is itself a symlink to a directory is still a directory link.
 *
 * `process.platform` is redefined rather than mocked wholesale, so the real
 * `applyPlan` runs and the assertion is on the argument the real call carried.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from '../apply.js';
import type { ProjectionPlan } from '../../plan/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) };
});

let repo = '';
const realPlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

/** A plan with one skill symlink from `.agents/skills/<name>` into `.claude/skills`. */
function linkPlan(name: string): ProjectionPlan {
  return {
    actions: [
      {
        kind: 'symlink',
        artifact: 'skill',
        harness: 'claude-code',
        provenance: 'authored',
        name,
        source: `.agents/skills/${name}`,
        target: `.claude/skills/${name}`,
      },
    ],
    drops: [],
    warnings: [],
    notEnabled: [],
  };
}

/** The symlink type argument the apply stage passed for the single link it made. */
function requestedType(): unknown {
  expect(vi.mocked(symlinkSync)).toHaveBeenCalledTimes(1);
  return vi.mocked(symlinkSync).mock.calls[0][2];
}

describe('the Windows symlink type', () => {
  it('asks for a junction when the source is a real directory', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-symtype-real-'));
    mkdirSync(join(repo, '.agents', 'skills', 'plain'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'plain', 'SKILL.md'), '# plain\n');

    applyPlan(repo, linkPlan('plain'));

    expect(requestedType()).toBe('junction');
  });

  it('asks for a junction when the source is itself a symlink to a directory', () => {
    // A skill kept elsewhere in the repo and linked into `.agents/skills`. The
    // source is a link, but what it names is a DIRECTORY, so Windows still needs
    // a junction — reading the link itself instead of what it points at asks for
    // a file link and fails with EPERM off Developer Mode.
    repo = mkdtempSync(join(tmpdir(), 'harness-symtype-link-'));
    mkdirSync(join(repo, 'vendor', 'shared'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'shared', 'SKILL.md'), '# shared\n');
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    symlinkSync('../../vendor/shared', join(repo, '.agents', 'skills', 'linked'));
    vi.mocked(symlinkSync).mockClear();

    applyPlan(repo, linkPlan('linked'));

    expect(requestedType()).toBe('junction');
  });

  it('asks for a file link when the source is a file', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-symtype-file-'));
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'note'), 'not a dir\n');

    applyPlan(repo, linkPlan('note'));

    expect(requestedType()).toBe('file');
  });
});
