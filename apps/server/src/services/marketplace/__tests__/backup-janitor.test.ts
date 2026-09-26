/**
 * Tests for {@link recoverInterruptedInstalls}, the sweep that settles
 * interrupted marketplace installs across whole scopes at server startup
 * (DOR-175, DOR-2273). What each kind of record means is tested in
 * `install-recovery.test.ts`; these tests cover the sweep: which directories
 * it reads, that it finds every target with records, that one bad entry never
 * stops the rest, and that a target left to another process is looked at
 * again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import {
  globalSweepDirs,
  projectSweepDirs,
  projectsOfAgents,
  recoverInterruptedInstalls,
  retryInFlightTargetsLater,
  _internal,
  type InstallSweepSummary,
} from '../backup-janitor.js';
import { IN_FLIGHT_FLOOR_MS, _internal as recoveryInternal } from '../install-recovery.js';
import { currentRecordOwner, formatRecordOwner } from '../lib/record-owner.js';
import { createUninstallSibling, writeJournal } from '../lib/uninstall-journal.js';

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
function recordName(
  targetName: string,
  suffix: '' | '.absent' | '.committed' = '',
  createdAt = Date.now()
): string {
  return `${targetName}.dorkos-bak-${createdAt}-${formatRecordOwner(currentRecordOwner())}-${randomUUID()}${suffix}`;
}

/** Write a package directory holding one version file. */
async function writePackage(dir: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'version.txt'), version, 'utf8');
}

/** An empty summary, to compare against. */
const nothing: InstallSweepSummary = {
  settled: 0,
  kept: 0,
  discarded: 0,
  inFlightTargets: [],
  restoredAgentRoots: [],
};

describe('recoverInterruptedInstalls', () => {
  let dorkHome: string;
  let project: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'backup-janitor-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'backup-janitor-project-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(dorkHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('restores a crash-left backup instead of deleting it, even a day old (DOR-2273)', async () => {
    // The old sweep deleted any backup older than 24h — here, the only copy of
    // a plugin whose reinstall crashed before the new version landed.
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    await writePackage(path.join(pluginsRoot, recordName('code-review-suite', '', old)), 'v1');

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger);

    expect(summary).toEqual({ ...nothing, settled: 1 });
    expect(await readFile(path.join(pluginsRoot, 'code-review-suite', 'version.txt'), 'utf8')).toBe(
      'v1'
    );
    expect(await readdir(pluginsRoot)).toEqual(['code-review-suite']);
  });

  // Purpose (DOR-2245 review 8): an agent whose uninstall a crash interrupted
  // gets its agent.json back from recovery, which runs before Mesh exists; the
  // sweep names the root so startup can register the agent again.
  it('names the roots where a rolled-back uninstall restored an agent', async () => {
    const root = path.join(dorkHome, 'agents', 'bot');
    await mkdir(path.join(root, '.dork'), { recursive: true });
    await writeFile(path.join(root, '.dork', 'uninstalled-agent.json'), '{"id":"01A"}');
    const sibling = await createUninstallSibling(root);
    await mkdir(path.join(sibling, '.dork'), { recursive: true });
    await writeFile(path.join(sibling, '.dork', 'manifest.json'), '{}');
    await writeJournal(sibling, {
      version: 1,
      root,
      package: { name: 'bot', type: 'agent' },
      moves: [{ path: '.dork/manifest.json' }],
      phase: 'side-effects',
      agentUnregistered: true,
    });

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger);

    expect(summary).toEqual({ ...nothing, settled: 1, restoredAgentRoots: [root] });
    expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toBe('{"id":"01A"}');
  });

  it('sweeps every root a transaction writes into, global and per project', async () => {
    // Install roots, and the skills roots schedules are materialised into —
    // where a crash-left backup would be one more live schedule. The project
    // scope is the one the old sweep never reached.
    const dirs = [...globalSweepDirs(dorkHome), ...projectSweepDirs(project)];
    expect(dirs).toEqual([
      path.join(dorkHome, 'plugins'),
      path.join(dorkHome, 'agents'),
      path.join(dorkHome, 'shapes'),
      path.join(dorkHome, 'skills'),
      path.join(project, '.dork', 'plugins'),
      path.join(project, '.dork', 'agents'),
      path.join(project, '.dork', 'shapes'),
      path.join(project, '.agents', 'skills'),
    ]);
    for (const dir of dirs) await writePackage(path.join(dir, recordName('pkg')), 'v1');

    const summary = await recoverInterruptedInstalls(dirs, noopLogger);

    expect(summary.settled).toBe(dirs.length);
    for (const dir of dirs) {
      expect(await readdir(dir)).toEqual(['pkg']);
    }
  });

  it('sweeps the project an installed agent lives in, as well as the agent', () => {
    // An agent installed into a project is registered at
    // `<project>/.dork/agents/<name>`; its own records sit in `<project>/.dork`.
    const installed = path.join(project, '.dork', 'agents', 'researcher');
    const plain = path.join(project, 'elsewhere');

    expect(projectsOfAgents([installed, plain, installed])).toEqual([installed, project, plain]);
  });

  it('deletes committed leftovers and counts them', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await writePackage(path.join(pluginsRoot, 'flow'), 'v2');
    await writePackage(path.join(pluginsRoot, recordName('flow', '.committed')), 'v1');

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger);

    expect(summary).toEqual({ ...nothing, discarded: 1 });
    expect(await readdir(pluginsRoot)).toEqual(['flow']);
  });

  it('never touches installs, or names that only look like records', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await writePackage(path.join(pluginsRoot, 'code-review-suite'), 'installed');
    const lookalike = path.join(pluginsRoot, `weird-plugin.dorkos-bak-not-a-timestamp`);
    await writePackage(lookalike, 'not ours');
    const warn = vi.fn();

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), {
      ...noopLogger,
      warn,
    });

    expect(summary).toEqual(nothing);
    expect(await pathExists(lookalike)).toBe(true);
    expect(await pathExists(path.join(pluginsRoot, 'code-review-suite'))).toBe(true);
    // Only the lookalike is worth a word; an installed package is not.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('weird-plugin.dorkos-bak-'));
  });

  it('tolerates a scope with no install roots yet', async () => {
    expect(await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger)).toEqual(
      nothing
    );
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

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), {
      ...noopLogger,
      warn,
    });

    expect(summary.settled).toBe(1);
    expect(await pathExists(path.join(pluginsRoot, 'good-plugin'))).toBe(true);
    expect(await pathExists(badBackup)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad-plugin'));
  });

  it('keeps going when one directory cannot be read', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    await writePackage(path.join(dorkHome, 'agents', recordName('my-agent')), 'v1');
    const realRead = _internal.readNames;
    vi.spyOn(_internal, 'readNames').mockImplementation(async (dir) => {
      if (dir === pluginsRoot) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRead(dir);
    });

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger);

    expect(summary.settled).toBe(1);
    expect(await pathExists(path.join(dorkHome, 'agents', 'my-agent'))).toBe(true);
  });

  it('reports a target another process may be installing, and settles it on the retry', async () => {
    // A young backup written before owners were stamped: nothing proves its
    // writer is gone, so only the age floor may settle it — and a target left
    // at startup must not wait for the next restart.
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const legacy = path.join(pluginsRoot, `flow.dorkos-bak-${Date.now()}-${randomUUID()}`);
    await writePackage(legacy, 'v1');

    const summary = await recoverInterruptedInstalls(globalSweepDirs(dorkHome), noopLogger);
    expect(summary).toEqual({ ...nothing, inFlightTargets: [path.join(pluginsRoot, 'flow')] });
    expect(await pathExists(legacy)).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const retried = new Promise<InstallSweepSummary>((resolve) =>
      retryInFlightTargetsLater(summary.inFlightTargets, noopLogger, resolve)
    );
    vi.advanceTimersByTime(IN_FLIGHT_FLOOR_MS);

    expect(await retried).toEqual({ ...nothing, settled: 1 });
    expect(await readFile(path.join(pluginsRoot, 'flow', 'version.txt'), 'utf8')).toBe('v1');
  });

  it('schedules no retry when nothing was left', () => {
    vi.useFakeTimers();
    retryInFlightTargetsLater([], noopLogger, () => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });
});
