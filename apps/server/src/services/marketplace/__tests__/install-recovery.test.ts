/**
 * Tests for the install transaction's on-disk records and the recovery that
 * reads them after a crash (DOR-2273).
 *
 * Each "crash" test builds exactly the state a transaction leaves on disk at
 * one point of its life, then runs recovery the way a restarted server would,
 * and checks the person is left with a working install and that no copy of
 * the last good install was deleted. The ownership tests use a real second
 * process, because the case they guard is two DorkOS servers on one project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _internal,
  IN_FLIGHT_FLOOR_MS,
  isRecordSettleable,
  parseInstallRecordName,
  recoverInterruptedInstall,
} from '../install-recovery.js';
import {
  _internal as ownerInternal,
  currentRecordOwner,
  formatRecordOwner,
  type RecordOwner,
} from '../lib/record-owner.js';

/** Returns true when `target` exists on disk. */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** A record name for `target`, spelled exactly as the transaction writes it. */
function recordName(
  targetName: string,
  opts: {
    suffix?: '' | '.absent' | '.committed';
    createdAt?: number;
    owner?: RecordOwner | null;
  } = {}
): string {
  const createdAt = opts.createdAt ?? Date.now();
  const owner = opts.owner === undefined ? currentRecordOwner() : opts.owner;
  const ownerPart = owner === null ? '' : `${formatRecordOwner(owner)}-`;
  return `${targetName}.dorkos-bak-${createdAt}-${ownerPart}${randomUUID()}${opts.suffix ?? ''}`;
}

/** Write a small package directory whose one file says which version it is. */
async function writePackage(dir: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'version.txt'), version, 'utf8');
}

/** Which version a package directory holds. */
async function versionAt(dir: string): Promise<string> {
  return readFile(path.join(dir, 'version.txt'), 'utf8');
}

/** Start a real second process that stays alive until killed. */
function startOtherProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

/** Stop a process this test started, by the handle it holds. */
function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

describe('parseInstallRecordName', () => {
  it('reads each kind of record, with and without an owner', () => {
    // The grammar is what decides whether recovery may touch a directory at
    // all, so each spelling the transaction writes must parse to its kind.
    const owner = currentRecordOwner();
    expect(parseInstallRecordName(recordName('flow'))).toMatchObject({
      targetName: 'flow',
      kind: 'backup',
      owner,
    });
    expect(parseInstallRecordName(recordName('flow', { suffix: '.absent' }))?.kind).toBe('absent');
    expect(parseInstallRecordName(recordName('flow', { suffix: '.committed' }))?.kind).toBe(
      'committed'
    );
    // A backup written before owners were stamped still parses, owner-less.
    const legacy = parseInstallRecordName(recordName('flow', { owner: null }));
    expect(legacy).toMatchObject({ targetName: 'flow', kind: 'backup' });
    expect(legacy?.owner).toBeUndefined();
  });

  it('refuses a name that only contains the marker', () => {
    // "Never touch anything that isn't ours": anything short of the full
    // stamp is not provably a record.
    for (const name of [
      'flow',
      `flow.dorkos-bak-${Date.now()}-deadbeef`,
      `flow.dorkos-bak-not-a-timestamp`,
      `flow.dorkos-bak-${Date.now()}-${randomUUID()}.old`,
      `.dorkos-bak-${Date.now()}-${randomUUID()}`,
      `flow.dorkos-bak-${Date.now()}-${randomUUID().toUpperCase()}`,
    ]) {
      expect(parseInstallRecordName(name), name).toBeUndefined();
    }
  });
});

describe('recoverInterruptedInstall', () => {
  let root: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'install-recovery-test-'));
    target = path.join(root, 'flow');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('restores the backup when a crash left the target missing (the DOR-2273 bug)', async () => {
    // The old janitor deleted this backup once it was a day old, leaving the
    // person with neither the old package nor the new one.
    const backup = path.join(root, recordName('flow'));
    await writePackage(backup, 'v1');

    const report = await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await exists(backup)).toBe(false);
    expect(report.rolledBack.map((r) => r.kind)).toEqual(['backup']);
  });

  it('replaces a half-written target with the backup', async () => {
    // A target that exists is not proof of a whole install: an agent's files
    // land before its workspace is scaffolded.
    await writePackage(target, 'v2-half');
    const backup = path.join(root, recordName('flow'));
    await writePackage(backup, 'v1');

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(root)).toEqual(['flow']);
  });

  it('removes a half-written fresh install and its marker', async () => {
    // Nothing was installed before, so "working" means "not installed".
    await writePackage(target, 'v1-half');
    const marker = path.join(root, recordName('flow', { suffix: '.absent' }));
    await writeFile(marker, '');

    await recoverInterruptedInstall(target);

    expect(await readdir(root)).toEqual([]);
  });

  it('clears a fresh-install marker whose target never appeared', async () => {
    await writeFile(path.join(root, recordName('flow', { suffix: '.absent' })), '');

    await recoverInterruptedInstall(target);

    expect(await readdir(root)).toEqual([]);
  });

  it('deletes a committed leftover and keeps the finished install', async () => {
    // Committed means the new install finished; the old copy is only waste.
    await writePackage(target, 'v2');
    await writePackage(path.join(root, recordName('flow', { suffix: '.committed' })), 'v1');

    const report = await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v2');
    expect(await readdir(root)).toEqual(['flow']);
    expect(report.discarded).toHaveLength(1);
    expect(report.rolledBack).toEqual([]);
  });

  it('undoes several interrupted transactions newest first, back to the last committed install', async () => {
    // Two uncommitted records can only stack up from an older server; undoing
    // the newer first is what walks the target back to v1, not to v2-half.
    const now = Date.now();
    await writePackage(target, 'v3-half');
    await writePackage(path.join(root, recordName('flow', { createdAt: now - 2_000 })), 'v1');
    await writePackage(path.join(root, recordName('flow', { createdAt: now - 1_000 })), 'v2-half');

    const report = await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await readdir(root)).toEqual(['flow']);
    expect(report.rolledBack.map((r) => r.createdAt)).toEqual([now - 1_000, now - 2_000]);
  });

  it('keeps the backup on disk when restoring it fails, so a later attempt can finish', async () => {
    // Never delete the only copy: a failed restore must leave the backup
    // exactly where recovery will find it next time.
    const backupName = recordName('flow');
    await writePackage(path.join(root, backupName), 'v1');
    vi.spyOn(_internal, 'move').mockRejectedValueOnce(new Error('EACCES'));

    await expect(recoverInterruptedInstall(target)).rejects.toThrow('EACCES');
    expect(await readdir(root)).toEqual([backupName]);

    await recoverInterruptedInstall(target);
    expect(await versionAt(target)).toBe('v1');
  });

  it('touches only this target and only real records', async () => {
    const other = path.join(root, recordName('flow-extra'));
    await writePackage(other, 'other');
    const lookalike = path.join(root, `flow.dorkos-bak-${Date.now()}-deadbeef`);
    await writePackage(lookalike, 'not ours');
    await writePackage(path.join(root, 'flow-notes'), 'unrelated');
    await writePackage(path.join(root, recordName('flow')), 'v1');

    await recoverInterruptedInstall(target);

    expect(await versionAt(target)).toBe('v1');
    expect(await versionAt(other)).toBe('other');
    expect(await versionAt(lookalike)).toBe('not ours');
    expect(await versionAt(path.join(root, 'flow-notes'))).toBe('unrelated');
  });

  it('does nothing when the install root does not exist', async () => {
    const report = await recoverInterruptedInstall(path.join(root, 'missing', 'flow'));
    expect(report).toEqual({ rolledBack: [], discarded: [], discardFailures: [], inFlight: [] });
  });

  describe('when another process wrote the record', () => {
    let other: ChildProcess | undefined;

    afterEach(async () => {
      if (other) await stopProcess(other);
      other = undefined;
    });

    /** The owner a record written by `child` would carry. */
    function ownerOf(child: ChildProcess): RecordOwner {
      const startedAt = ownerInternal.readProcessStartSeconds(child.pid!);
      return { ...currentRecordOwner(), pid: child.pid!, startedAt: startedAt ?? 0 };
    }

    it('leaves a live process’s young record alone, then restores it once that process is gone', async () => {
      // Two servers with different data dirs share this project. Undoing the
      // other one's record between its two renames would destroy its install.
      other = await startOtherProcess();
      await writePackage(target, 'v2-being-installed');
      const backup = path.join(root, recordName('flow', { owner: ownerOf(other) }));
      await writePackage(backup, 'v1');

      const whileRunning = await recoverInterruptedInstall(target);
      expect(whileRunning.inFlight).toHaveLength(1);
      expect(await versionAt(target)).toBe('v2-being-installed');
      expect(await versionAt(backup)).toBe('v1');

      await stopProcess(other);
      const afterExit = await recoverInterruptedInstall(target);
      expect(afterExit.rolledBack).toHaveLength(1);
      expect(await versionAt(target)).toBe('v1');
    });

    it('leaves every record of the target alone while any one is in flight', async () => {
      // Undoing an older record underneath a live one would corrupt it.
      other = await startOtherProcess();
      const now = Date.now();
      const older = path.join(root, recordName('flow', { createdAt: now - 60_000 }));
      await writePackage(older, 'v1');
      const committed = path.join(root, recordName('flow', { suffix: '.committed' }));
      await writePackage(committed, 'v0');
      const live = path.join(root, recordName('flow', { owner: ownerOf(other) }));
      await writePackage(live, 'v2');

      await recoverInterruptedInstall(target);

      expect(await exists(older)).toBe(true);
      expect(await exists(committed)).toBe(true);
      expect(await exists(live)).toBe(true);
    });

    it('treats a recycled pid as gone', async () => {
      // The record's pid now belongs to a process that started an hour after
      // the record's writer did, so the writer is not running.
      other = await startOtherProcess();
      const owner = ownerOf(other);
      expect(owner.startedAt).toBeGreaterThan(0);
      await writePackage(
        path.join(
          root,
          recordName('flow', { owner: { ...owner, startedAt: owner.startedAt - 3600 } })
        ),
        'v1'
      );

      await recoverInterruptedInstall(target);

      expect(await versionAt(target)).toBe('v1');
    });

    it('waits for the age floor when the writer is on another machine', async () => {
      // A project in a synced folder can carry a record to another host, where
      // a pid proves nothing either way.
      const elsewhere: RecordOwner = { ...currentRecordOwner(), pid: 999_999, host: '00000000' };
      const young = path.join(root, recordName('flow', { owner: elsewhere }));
      await writePackage(young, 'v1');

      expect((await recoverInterruptedInstall(target)).inFlight).toHaveLength(1);
      expect(await exists(target)).toBe(false);

      const now = Date.now();
      const record = (await recoverInterruptedInstall(target)).inFlight[0]!;
      expect(isRecordSettleable(record, now + IN_FLIGHT_FLOOR_MS)).toBe(true);
    });

    it('waits for the age floor when a running writer’s start time cannot be read', async () => {
      // Windows, or a `ps` that failed: alive and unconfirmed is never "gone".
      other = await startOtherProcess();
      vi.spyOn(ownerInternal, 'readProcessStartSeconds').mockReturnValue(null);
      await writePackage(path.join(root, recordName('flow', { owner: ownerOf(other) })), 'v1');

      expect((await recoverInterruptedInstall(target)).inFlight).toHaveLength(1);
    });

    it('waits for the age floor when the writer could not read its own start time', async () => {
      // A record written where `ps` failed carries start time 0. Its pid is
      // running, and "unknown" must never be read as "started long ago, so
      // recycled".
      other = await startOtherProcess();
      await writePackage(
        path.join(root, recordName('flow', { owner: { ...ownerOf(other), startedAt: 0 } })),
        'v1'
      );

      expect((await recoverInterruptedInstall(target)).inFlight).toHaveLength(1);
    });

    it('waits for the age floor for a young backup written before owners were stamped', async () => {
      await writePackage(path.join(root, recordName('flow', { owner: null })), 'v1');

      expect((await recoverInterruptedInstall(target)).inFlight).toHaveLength(1);
      expect(await exists(target)).toBe(false);
    });

    it('settles any record older than the age floor, whoever wrote it', async () => {
      // No transaction holds a record for ten minutes, so an old one is crash
      // residue even if its writer's pid is still running.
      other = await startOtherProcess();
      const old = Date.now() - IN_FLIGHT_FLOOR_MS - 1_000;
      await writePackage(
        path.join(root, recordName('flow', { owner: ownerOf(other), createdAt: old })),
        'v1'
      );
      await writePackage(
        path.join(root, recordName('flow', { owner: null, createdAt: old - 1 })),
        'v0'
      );

      await recoverInterruptedInstall(target);

      expect(await versionAt(target)).toBe('v0');
      expect(await readdir(root)).toEqual(['flow']);
    });

    it('settles a record whose writer exited', async () => {
      other = await startOtherProcess();
      const owner = ownerOf(other);
      await stopProcess(other);
      await writePackage(path.join(root, recordName('flow', { owner })), 'v1');

      await recoverInterruptedInstall(target);

      expect(await versionAt(target)).toBe('v1');
    });
  });
});
