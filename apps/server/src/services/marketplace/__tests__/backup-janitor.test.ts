/**
 * Tests for {@link recoverInterruptedInstalls}, the sweep that settles
 * interrupted marketplace installs across whole scopes at server startup
 * (DOR-175, DOR-2273). What each kind of record means is tested in
 * `install-recovery.test.ts`; these tests cover the sweep: which directories
 * it reads, that it finds every target with records, and that one bad entry
 * never stops the rest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import { recoverInterruptedInstalls, _internal } from '../backup-janitor.js';
import { _internal as recoveryInternal } from '../install-recovery.js';
import { currentRecordOwner, formatRecordOwner } from '../lib/record-owner.js';

/** Returns true when `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** A record name exactly as the transaction writes it, owned by this process. */
function recordName(targetName: string, suffix: '' | '.absent' | '.committed' = ''): string {
  return `${targetName}.dorkos-bak-${Date.now()}-${formatRecordOwner(currentRecordOwner())}-${randomUUID()}${suffix}`;
}

/** Write a package directory holding one version file. */
async function writePackage(dir: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'version.txt'), version, 'utf8');
}

describe('recoverInterruptedInstalls', () => {
  let dorkHome: string;
  let project: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'backup-janitor-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'backup-janitor-project-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('restores a crash-left backup instead of deleting it, even a day old (DOR-2273)', async () => {
    // The old sweep deleted any backup older than 24h — here, the only copy of
    // a plugin whose reinstall crashed before the new version landed.
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const backup = path.join(
      pluginsRoot,
      `code-review-suite.dorkos-bak-${old}-${formatRecordOwner(currentRecordOwner())}-${randomUUID()}`
    );
    await writePackage(backup, 'v1');

    const summary = await recoverInterruptedInstalls([dorkHome], noopLogger);

    expect(summary).toEqual({ rolledBack: 1, discarded: 0, inFlight: 0 });
    expect(await readFile(path.join(pluginsRoot, 'code-review-suite', 'version.txt'), 'utf8')).toBe(
      'v1'
    );
    expect(await readdir(pluginsRoot)).toEqual(['code-review-suite']);
  });

  it('settles every install root of every scope it is given', async () => {
    // Global plugins/agents/shapes, and a project's own `.dork/` — the scope
    // the old sweep never reached, so a project backup lingered forever.
    const scopes = [dorkHome, path.join(project, '.dork')];
    for (const scope of scopes) {
      for (const root of ['plugins', 'agents', 'shapes']) {
        await writePackage(path.join(scope, root, recordName('pkg')), `${root}-v1`);
      }
    }

    const summary = await recoverInterruptedInstalls(scopes, noopLogger);

    expect(summary.rolledBack).toBe(6);
    for (const scope of scopes) {
      for (const root of ['plugins', 'agents', 'shapes']) {
        expect(await readdir(path.join(scope, root))).toEqual(['pkg']);
        expect(await readFile(path.join(scope, root, 'pkg', 'version.txt'), 'utf8')).toBe(
          `${root}-v1`
        );
      }
    }
  });

  it('deletes committed leftovers and counts them', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await writePackage(path.join(pluginsRoot, 'flow'), 'v2');
    await writePackage(path.join(pluginsRoot, recordName('flow', '.committed')), 'v1');

    const summary = await recoverInterruptedInstalls([dorkHome], noopLogger);

    expect(summary).toEqual({ rolledBack: 0, discarded: 1, inFlight: 0 });
    expect(await readdir(pluginsRoot)).toEqual(['flow']);
  });

  it('never touches installs, or names that only look like records', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await writePackage(path.join(pluginsRoot, 'code-review-suite'), 'installed');
    const lookalike = path.join(pluginsRoot, `weird-plugin.dorkos-bak-not-a-timestamp`);
    await writePackage(lookalike, 'not ours');
    const warn = vi.fn();

    const summary = await recoverInterruptedInstalls([dorkHome], { ...noopLogger, warn });

    expect(summary).toEqual({ rolledBack: 0, discarded: 0, inFlight: 0 });
    expect(await pathExists(lookalike)).toBe(true);
    expect(await pathExists(path.join(pluginsRoot, 'code-review-suite'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('weird-plugin.dorkos-bak-'));
  });

  it('tolerates a scope with no install roots yet', async () => {
    const summary = await recoverInterruptedInstalls([dorkHome], noopLogger);
    expect(summary).toEqual({ rolledBack: 0, discarded: 0, inFlight: 0 });
  });

  it('keeps going when one target cannot be settled, and keeps that target’s backup', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const badBackup = path.join(pluginsRoot, recordName('bad-plugin'));
    await writePackage(badBackup, 'v1');
    await writePackage(path.join(pluginsRoot, recordName('good-plugin')), 'v1');
    const realMove = recoveryInternal.move;
    vi.spyOn(recoveryInternal, 'move').mockImplementation(async (from, to) => {
      if (from === badBackup) throw new Error('EACCES: permission denied');
      return realMove(from, to);
    });
    const warn = vi.fn();

    const summary = await recoverInterruptedInstalls([dorkHome], { ...noopLogger, warn });

    expect(summary.rolledBack).toBe(1);
    expect(await pathExists(path.join(pluginsRoot, 'good-plugin'))).toBe(true);
    expect(await pathExists(badBackup)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad-plugin'));
  });

  it('keeps going when one install root cannot be read', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    await writePackage(path.join(dorkHome, 'agents', recordName('my-agent')), 'v1');
    const realRead = _internal.readNames;
    vi.spyOn(_internal, 'readNames').mockImplementation(async (dir) => {
      if (dir === pluginsRoot) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRead(dir);
    });

    const summary = await recoverInterruptedInstalls([dorkHome], noopLogger);

    expect(summary.rolledBack).toBe(1);
    expect(await pathExists(path.join(dorkHome, 'agents', 'my-agent'))).toBe(true);
  });

  it('reports a target another process may be installing, and leaves it alone', async () => {
    // A young backup written before owners were stamped: nothing proves its
    // writer is gone, so only the age floor may settle it.
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const legacy = path.join(pluginsRoot, `flow.dorkos-bak-${Date.now()}-${randomUUID()}`);
    await writePackage(legacy, 'v1');

    const summary = await recoverInterruptedInstalls([dorkHome], noopLogger);

    expect(summary).toEqual({ rolledBack: 0, discarded: 0, inFlight: 1 });
    expect(await pathExists(legacy)).toBe(true);
  });
});
