/**
 * The two recovery rows DOR-2245 adds to DOR-2273's policy table, and the
 * "whole" check before a committed backup is discarded (spec §14).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  IN_FLIGHT_FLOOR_MS,
  isRecordSettleable,
  parseInstallRecordName,
  recoverInterruptedInstall,
} from '../install-recovery.js';
import { currentRecordOwner, formatRecordOwner, type RecordOwner } from '../lib/record-owner.js';
import { computeInstalledFiles, writeInstalledFiles } from '../lib/installed-files.js';
import { journaledMove, writeJournal, type UninstallJournal } from '../lib/uninstall-journal.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function base(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'recovery-ownership-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function exists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined)) !== undefined;
}

function sibling(
  target: string,
  marker: string,
  owner: RecordOwner = currentRecordOwner(),
  createdAt = Date.now()
): string {
  return `${target}${marker}${createdAt}-${formatRecordOwner(owner)}-${randomUUID()}`;
}

/** A root partway through an uninstall: `a.md` and the manifest already moved. */
async function interruptedUninstall(
  phase: UninstallJournal['phase']
): Promise<{ root: string; sib: string }> {
  const dir = await base();
  const root = path.join(dir, 'pkg');
  await put(root, '.dork/manifest.json', '{"name":"pkg"}');
  await put(root, 'a.md', 'a');
  await put(root, 'mine.txt', 'mine');
  const sib = sibling(root, '.dorkos-uninstall-');
  await mkdir(sib);
  const journal: UninstallJournal = {
    version: 1,
    root,
    package: { name: 'pkg', type: 'plugin' },
    moves: [],
    phase: 'moving',
  };
  await writeJournal(sib, journal);
  await journaledMove({ root, sibling: sib, journal, move: { path: 'a.md' } });
  await journaledMove({ root, sibling: sib, journal, move: { path: '.dork/manifest.json' } });
  journal.phase = phase;
  await writeJournal(sib, journal);
  return { root, sib };
}

describe('recovery of DOR-2245 siblings', () => {
  // Purpose: both new markers parse as records under the shared stamp grammar.
  it('parses stage and uninstall sibling names', () => {
    expect(parseInstallRecordName(path.basename(sibling('/x/pkg', '.dorkos-stage-')))?.kind).toBe(
      'stage'
    );
    expect(
      parseInstallRecordName(path.basename(sibling('/x/pkg', '.dorkos-uninstall-')))?.kind
    ).toBe('uninstall');
  });

  // Purpose: a crash-left staging dir holds only copies; it is deleted.
  it('discards a crash-left staging dir', async () => {
    const dir = await base();
    const target = path.join(dir, 'pkg');
    await put(target, 'mine.txt', 'mine');
    const stage = sibling(target, '.dorkos-stage-');
    await put(stage, 'copy.txt', 'copy');
    const report = await recoverInterruptedInstall(target);
    expect(await exists(stage)).toBe(false);
    expect(report.discarded.map((r) => r.kind)).toEqual(['stage']);
    expect(await readFile(path.join(target, 'mine.txt'), 'utf8')).toBe('mine');
  });

  // Purpose: an uninstall interrupted before its commit is rolled back, identity first.
  it('rolls back an uncommitted uninstall', async () => {
    const { root, sib } = await interruptedUninstall('side-effects');
    const report = await recoverInterruptedInstall(root);
    expect(report.settled.map((s) => s.outcome)).toEqual(['rolled-back']);
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('a');
    expect(await exists(path.join(root, '.dork', 'manifest.json'))).toBe(true);
    expect(await exists(sib)).toBe(false);
  });

  // Purpose: a committed uninstall is finished, never undone.
  it('finishes a committed uninstall', async () => {
    const { root, sib } = await interruptedUninstall('committed');
    const report = await recoverInterruptedInstall(root);
    expect(report.settled.map((s) => s.outcome)).toEqual(['rolled-forward']);
    expect(await exists(sib)).toBe(false);
    expect(await readFile(path.join(root, 'mine.txt'), 'utf8')).toBe('mine');
    expect(await exists(path.join(root, 'a.md'))).toBe(false);
  });

  // Purpose: no readable journal means nothing proves what it holds: keep it.
  it('keeps an uninstall sibling with no readable journal', async () => {
    const dir = await base();
    const root = path.join(dir, 'pkg');
    await put(root, 'mine.txt', 'mine');
    const sib = sibling(root, '.dorkos-uninstall-');
    await put(sib, 'a.md', 'a');
    const report = await recoverInterruptedInstall(root);
    expect(report.kept.map((r) => r.kind)).toEqual(['uninstall']);
    expect(await exists(path.join(sib, 'a.md'))).toBe(true);
  });

  // Purpose: a parked agent identity comes back when an uninstall rolls back.
  it('restores a parked agent.json on rollback', async () => {
    const { root } = await interruptedUninstall('side-effects');
    await put(root, '.dork/uninstalled-agent.json', '{"id":"01A"}');
    await recoverInterruptedInstall(root);
    expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toBe('{"id":"01A"}');
    expect(await exists(path.join(root, '.dork', 'uninstalled-agent.json'))).toBe(false);
  });

  // Purpose: the ignore option protects a transaction's own staging dir.
  it('leaves an ignored record alone', async () => {
    const dir = await base();
    const target = path.join(dir, 'pkg');
    const stage = sibling(target, '.dorkos-stage-');
    await mkdir(stage, { recursive: true });
    await recoverInterruptedInstall(target, { ignore: new Set([stage]) });
    expect(await exists(stage)).toBe(true);
  });
});

describe('the "whole" check before discarding a committed backup', () => {
  // Purpose: a live install missing a recorded file keeps its previous copy.
  it('keeps the committed backup when the live install is broken', async () => {
    const dir = await base();
    const target = path.join(dir, 'pkg');
    await put(target, 'a.md', 'a');
    await put(target, 'b.md', 'b');
    await writeInstalledFiles(
      target,
      await computeInstalledFiles(target, {
        identity: { name: 'pkg', type: 'plugin' },
        userEditable: [],
        npmRan: false,
      })
    );
    await rm(path.join(target, 'b.md'));
    const committed = `${sibling(target, '.dorkos-bak-')}.committed`;
    await put(committed, 'a.md', 'old');
    const report = await recoverInterruptedInstall(target);
    expect(report.kept.map((r) => r.kind)).toEqual(['committed']);
    expect(await exists(committed)).toBe(true);
  });

  // Purpose: a whole install's committed leftovers are still deleted.
  it('discards the committed backup when the live install is whole', async () => {
    const dir = await base();
    const target = path.join(dir, 'pkg');
    await put(target, 'a.md', 'a');
    await writeInstalledFiles(
      target,
      await computeInstalledFiles(target, {
        identity: { name: 'pkg', type: 'plugin' },
        userEditable: [],
        npmRan: false,
      })
    );
    const committed = `${sibling(target, '.dorkos-bak-')}.committed`;
    await put(committed, 'a.md', 'old');
    await recoverInterruptedInstall(target);
    expect(await exists(committed)).toBe(false);
    expect(await readdir(dir)).toEqual(['pkg']);
  });
});

describe('owner-stamp requirements from round 4 (met by DOR-2273)', () => {
  // Purpose: a record from another host is never settled before the floor.
  it('waits for the floor on a record from a different host', () => {
    const me = currentRecordOwner();
    const record = {
      path: '/x',
      kind: 'stage' as const,
      createdAt: Date.now(),
      owner: { ...me, host: me.host === 'deadbeef' ? 'cafef00d' : 'deadbeef' },
    };
    expect(isRecordSettleable(record, Date.now())).toBe(false);
    expect(isRecordSettleable(record, Date.now() + IN_FLIGHT_FLOOR_MS + 1)).toBe(true);
  });

  // Purpose: an unreadable start time (Windows) never reads as "gone".
  it('waits for the floor when the writer start time is unknown', () => {
    const me = currentRecordOwner();
    // A live pid that is not this process: the parent.
    const record = {
      path: '/x',
      kind: 'uninstall' as const,
      createdAt: Date.now(),
      owner: { pid: process.ppid, startedAt: 0, host: me.host },
    };
    expect(isRecordSettleable(record, Date.now())).toBe(false);
  });
});
