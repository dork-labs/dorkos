/**
 * Filesystem oracles: each has a PASSING case and a deliberately FAILING case
 * (the side effect did NOT happen), so a broken always-pass oracle is caught
 * (spec §Testing Strategy).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EvalSandbox, OracleContext } from '../../types.js';
import {
  fileExists,
  dirAbsent,
  fileMatches,
  noBackupSiblings,
  dirContainsOnly,
} from '../filesystem.js';

let sandbox: EvalSandbox;
let root: string;

/** Build an OracleContext over the temp sandbox (no server/frames needed). */
function ctx(): OracleContext {
  return { sandbox, baseUrl: 'http://unused', sessionId: 's', frames: [] };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'evals-fs-'));
  sandbox = { dorkHome: path.join(root, '.dork'), projectCwd: path.join(root, 'project') };
  await mkdir(sandbox.dorkHome, { recursive: true });
  await mkdir(sandbox.projectCwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fileExists', () => {
  it('passes when the file exists', async () => {
    const target = path.join(sandbox.dorkHome, 'install-metadata.json');
    await writeFile(target, '{}');
    const result = await fileExists((s) => path.join(s.dorkHome, 'install-metadata.json'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the file does not exist (the install never happened)', async () => {
    const result = await fileExists((s) => path.join(s.dorkHome, 'missing.json'))(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('expected path to exist');
  });
});

describe('dirAbsent', () => {
  it('passes when the directory is gone (uninstall removed it)', async () => {
    const result = await dirAbsent((s) => path.join(s.projectCwd, '.dork/plugins/foo'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the directory still exists', async () => {
    const dir = path.join(sandbox.projectCwd, '.dork/plugins/foo');
    await mkdir(dir, { recursive: true });
    const result = await dirAbsent((s) => path.join(s.projectCwd, '.dork/plugins/foo'))(ctx());
    expect(result.passed).toBe(false);
  });
});

describe('fileMatches', () => {
  it('passes when the contents match the RegExp', async () => {
    const target = path.join(sandbox.projectCwd, 'agent.json');
    await writeFile(target, JSON.stringify({ name: 'helper' }));
    const result = await fileMatches((s) => path.join(s.projectCwd, 'agent.json'), /helper/)(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the file is missing or the contents do not match', async () => {
    const target = path.join(sandbox.projectCwd, 'agent.json');
    await writeFile(target, JSON.stringify({ name: 'unchanged' }));
    const result = await fileMatches(
      (s) => path.join(s.projectCwd, 'agent.json'),
      /modified/
    )(ctx());
    expect(result.passed).toBe(false);
  });
});

describe('dirContainsOnly', () => {
  it('passes when every top-level entry is in the allowlist (only .dork present)', async () => {
    await mkdir(path.join(sandbox.projectCwd, '.dork'), { recursive: true });
    const result = await dirContainsOnly((s) => s.projectCwd, ['.dork'])(ctx());
    expect(result.passed).toBe(true);
  });

  it('passes for a missing directory (nothing was created)', async () => {
    const result = await dirContainsOnly((s) => path.join(s.projectCwd, 'nope'), ['.dork'])(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the turn created an unexpected entry (started real work)', async () => {
    await mkdir(path.join(sandbox.projectCwd, '.dork'), { recursive: true });
    await writeFile(path.join(sandbox.projectCwd, 'CHANGELOG.md'), '# stray work');
    const result = await dirContainsOnly((s) => s.projectCwd, ['.dork'])(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('CHANGELOG.md');
  });
});

describe('noBackupSiblings', () => {
  it('passes when no *.dorkos-bak-* leftover remains', async () => {
    const dir = path.join(sandbox.projectCwd, '.dork/plugins');
    await mkdir(dir, { recursive: true });
    const result = await noBackupSiblings((s) => path.join(s.projectCwd, '.dork/plugins'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when a crash-left backup sibling remains', async () => {
    const dir = path.join(sandbox.projectCwd, '.dork/plugins');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'foo.dorkos-bak-123-abc'), '');
    const result = await noBackupSiblings((s) => path.join(s.projectCwd, '.dork/plugins'))(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('leftover backups');
  });
});
