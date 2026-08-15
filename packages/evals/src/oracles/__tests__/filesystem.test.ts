/**
 * Filesystem oracles: each has a PASSING case and a deliberately FAILING case
 * (the side effect did NOT happen), so a broken always-pass oracle is caught
 * (spec §Testing Strategy).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyApprovalLog, type EvalSandbox, type OracleContext } from '../../types.js';
import {
  fileExists,
  pathAbsent,
  fileMatches,
  jsonFileMatches,
  noBackupSiblings,
  dirContainsOnly,
  dirEmptyOrAbsent,
} from '../filesystem.js';

let sandbox: EvalSandbox;
let root: string;

/** Build an OracleContext over the temp sandbox (no server/frames needed). */
function ctx(): OracleContext {
  return {
    sandbox,
    baseUrl: 'http://unused',
    sessionId: 's',
    frames: [],
    approvals: emptyApprovalLog(),
  };
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

describe('pathAbsent', () => {
  it('passes when the directory is gone (uninstall removed it)', async () => {
    const result = await pathAbsent((s) => path.join(s.projectCwd, '.dork/plugins/foo'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the directory still exists', async () => {
    const dir = path.join(sandbox.projectCwd, '.dork/plugins/foo');
    await mkdir(dir, { recursive: true });
    const result = await pathAbsent((s) => path.join(s.projectCwd, '.dork/plugins/foo'))(ctx());
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

describe('jsonFileMatches', () => {
  it('passes when the parsed JSON satisfies the predicate (ui.statusBar flipped)', async () => {
    const target = path.join(sandbox.dorkHome, 'config.json');
    await writeFile(target, JSON.stringify({ ui: { statusBar: { git: false } } }));
    const result = await jsonFileMatches(
      (s) => path.join(s.dorkHome, 'config.json'),
      (value) => (value as { ui?: { statusBar?: { git?: unknown } } }).ui?.statusBar?.git === false
    )(ctx());
    expect(result.passed).toBe(true);
  });

  it('fails when the parsed JSON does not satisfy the predicate (setting unchanged)', async () => {
    const target = path.join(sandbox.dorkHome, 'config.json');
    await writeFile(target, JSON.stringify({ ui: { statusBar: { git: true } } }));
    const result = await jsonFileMatches(
      (s) => path.join(s.dorkHome, 'config.json'),
      (value) => (value as { ui?: { statusBar?: { git?: unknown } } }).ui?.statusBar?.git === false
    )(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('did not match');
  });

  it('fails when the file is missing (the write never landed)', async () => {
    const result = await jsonFileMatches(
      (s) => path.join(s.dorkHome, 'missing.json'),
      () => true
    )(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('does not exist');
  });

  it('fails when the file is not valid JSON', async () => {
    const target = path.join(sandbox.dorkHome, 'config.json');
    await writeFile(target, 'not json {');
    const result = await jsonFileMatches(
      (s) => path.join(s.dorkHome, 'config.json'),
      () => true
    )(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('not valid JSON');
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

describe('dirEmptyOrAbsent', () => {
  it('passes when the directory is absent (nothing was ever installed)', async () => {
    const result = await dirEmptyOrAbsent((s) => path.join(s.dorkHome, 'plugins'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('passes when the directory exists but is empty', async () => {
    await mkdir(path.join(sandbox.dorkHome, 'plugins'), { recursive: true });
    const result = await dirEmptyOrAbsent((s) => path.join(s.dorkHome, 'plugins'))(ctx());
    expect(result.passed).toBe(true);
  });

  it('FAILS when something was installed, and names it', async () => {
    await mkdir(path.join(sandbox.dorkHome, 'plugins', 'sneaky-pkg'), { recursive: true });
    const result = await dirEmptyOrAbsent((s) => path.join(s.dorkHome, 'plugins'))(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('sneaky-pkg');
  });

  it('FAILS rather than passes when the path cannot be read', async () => {
    // An oracle that reports success because it could not LOOK is the precise
    // false-green this harness exists to remove. Only ENOENT means "absent";
    // ENOTDIR (a file where a directory was expected) must fail.
    const target = path.join(sandbox.dorkHome, 'plugins');
    await writeFile(target, 'not a directory', 'utf8');
    const result = await dirEmptyOrAbsent((s) => path.join(s.dorkHome, 'plugins'))(ctx());
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/could not read/);
    expect(result.evidence).toMatchObject({ unreadable: true, code: 'ENOTDIR' });
  });
});
