/**
 * Tests for {@link sweepStaleInstallBackups}, the startup janitor that
 * removes crash-left `*.dorkos-bak-*` marketplace install backups (DOR-175,
 * ADR-0304).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import { sweepStaleInstallBackups, _internal } from '../backup-janitor.js';
import { BACKUP_SUFFIX } from '../transaction.js';

/** Returns true when `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a backup directory name exactly as `transaction.ts`'s
 * `moveTargetAside` does: `<target-basename><BACKUP_SUFFIX><timestamp>-<uuid>`.
 */
function backupName(targetBasename: string, timestamp: number): string {
  return `${targetBasename}${BACKUP_SUFFIX}${timestamp}-${randomUUID()}`;
}

describe('sweepStaleInstallBackups', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'backup-janitor-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
  });

  it('removes a stale backup dir under <dorkHome>/plugins', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25h old
    const stalePath = path.join(pluginsRoot, backupName('code-review-suite', staleTimestamp));
    await mkdir(stalePath, { recursive: true });
    await writeFile(path.join(stalePath, 'marker.txt'), 'leftover', 'utf8');

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);

    expect(removed).toBe(1);
    expect(await pathExists(stalePath)).toBe(false);
  });

  it('removes a stale backup dir under <dorkHome>/agents', async () => {
    const agentsRoot = path.join(dorkHome, 'agents');
    await mkdir(agentsRoot, { recursive: true });
    const staleTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48h old
    const stalePath = path.join(agentsRoot, backupName('my-agent', staleTimestamp));
    await mkdir(stalePath, { recursive: true });

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);

    expect(removed).toBe(1);
    expect(await pathExists(stalePath)).toBe(false);
  });

  it('removes a stale backup dir under <dorkHome>/shapes (DOR-355 regression)', async () => {
    // Shapes install to shapes/, a root the janitor originally never swept —
    // a crash mid-Shape-reinstall left an unreclaimed .dorkos-bak orphan.
    const shapesRoot = path.join(dorkHome, 'shapes');
    await mkdir(shapesRoot, { recursive: true });
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25h old
    const stalePath = path.join(shapesRoot, backupName('linear-ops', staleTimestamp));
    await mkdir(stalePath, { recursive: true });
    await writeFile(path.join(stalePath, 'marker.txt'), 'leftover', 'utf8');

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);

    expect(removed).toBe(1);
    expect(await pathExists(stalePath)).toBe(false);
  });

  it('spares a fresh backup dir (default 24h threshold) — guards a live transaction', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    const freshPath = path.join(pluginsRoot, backupName('code-review-suite', Date.now()));
    await mkdir(freshPath, { recursive: true });

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);

    expect(removed).toBe(0);
    expect(await pathExists(freshPath)).toBe(true);
  });

  it('spares a backup dir just inside a custom maxAgeMs threshold', async () => {
    const agentsRoot = path.join(dorkHome, 'agents');
    await mkdir(agentsRoot, { recursive: true });
    const oneMinuteAgo = Date.now() - 60_000;
    const livePath = path.join(agentsRoot, backupName('my-agent', oneMinuteAgo));
    await mkdir(livePath, { recursive: true });

    // A 5-minute threshold: a transaction that started 1 minute ago is still
    // plausibly in flight, so the sweep must not race it.
    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger, {
      maxAgeMs: 5 * 60_000,
    });

    expect(removed).toBe(0);
    expect(await pathExists(livePath)).toBe(true);
  });

  it('spares a backup timestamped exactly at the cutoff (>= is spared; 1ms older is swept)', async () => {
    // Pin the boundary semantics of `timestamp >= cutoff → spared` with a
    // frozen clock, so the comparison is exercised at exact equality rather
    // than depending on wall-clock drift between setup and sweep.
    const frozenNow = new Date('2026-07-17T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);

    const maxAgeMs = 60_000;
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    // cutoff = frozenNow - maxAgeMs. Exactly-at-cutoff → spared (>=).
    const atCutoffPath = path.join(pluginsRoot, backupName('at-cutoff', frozenNow - maxAgeMs));
    // One millisecond older than the cutoff → swept.
    const justPastPath = path.join(
      pluginsRoot,
      backupName('past-cutoff', frozenNow - maxAgeMs - 1)
    );
    await mkdir(atCutoffPath, { recursive: true });
    await mkdir(justPastPath, { recursive: true });

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger, { maxAgeMs });

    expect(removed).toBe(1);
    expect(await pathExists(atCutoffPath)).toBe(true);
    expect(await pathExists(justPastPath)).toBe(false);
  });

  it('never touches directories that are not backups, even in a swept root', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const installedPlugin = path.join(pluginsRoot, 'code-review-suite');
    await mkdir(installedPlugin, { recursive: true });
    await writeFile(path.join(installedPlugin, 'plugin.json'), '{}', 'utf8');

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger, { maxAgeMs: 0 });

    expect(removed).toBe(0);
    expect(await pathExists(installedPlugin)).toBe(true);
  });

  it('tolerates a missing dorkHome/plugins and dorkHome/agents (fresh install, nothing on disk yet)', async () => {
    // dorkHome exists but neither plugins/ nor agents/ has been created.
    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);
    expect(removed).toBe(0);
  });

  it('tolerates an fs error removing one stale backup and still sweeps the rest', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    const badPath = path.join(pluginsRoot, backupName('bad-plugin', staleTimestamp));
    const goodPath = path.join(pluginsRoot, backupName('good-plugin', staleTimestamp));
    await mkdir(badPath, { recursive: true });
    await mkdir(goodPath, { recursive: true });

    const realRemove = _internal.removeBackup;
    vi.spyOn(_internal, 'removeBackup').mockImplementation(async (target) => {
      if (target === badPath) throw new Error('EACCES: permission denied');
      return realRemove(target);
    });

    const warnSpy = vi.fn();
    const removed = await sweepStaleInstallBackups(dorkHome, { ...noopLogger, warn: warnSpy });

    // The good backup is still removed despite the bad one failing.
    expect(removed).toBe(1);
    expect(await pathExists(goodPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips a backup-marked name whose timestamp segment cannot be parsed, without throwing', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    // Matches BACKUP_SUFFIX but the segment after it is not `<digits>-...`.
    const malformedPath = path.join(pluginsRoot, `weird-plugin${BACKUP_SUFFIX}not-a-timestamp`);
    await mkdir(malformedPath, { recursive: true });

    const warnSpy = vi.fn();
    const removed = await sweepStaleInstallBackups(dorkHome, { ...noopLogger, warn: warnSpy });

    expect(removed).toBe(0);
    expect(await pathExists(malformedPath)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('tolerates a readdir error on one root and still sweeps the other', async () => {
    const pluginsRoot = path.join(dorkHome, 'plugins');
    const agentsRoot = path.join(dorkHome, 'agents');
    await mkdir(pluginsRoot, { recursive: true });
    await mkdir(agentsRoot, { recursive: true });
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    const agentBackup = path.join(agentsRoot, backupName('my-agent', staleTimestamp));
    await mkdir(agentBackup, { recursive: true });

    const realRead = _internal.readEntries;
    vi.spyOn(_internal, 'readEntries').mockImplementation(async (dir) => {
      if (dir === pluginsRoot) {
        const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw err;
      }
      return realRead(dir);
    });

    const removed = await sweepStaleInstallBackups(dorkHome, noopLogger);

    expect(removed).toBe(1);
    expect(await pathExists(agentBackup)).toBe(false);
  });
});
