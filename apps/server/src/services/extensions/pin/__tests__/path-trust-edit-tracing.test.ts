/**
 * The scan runs an edit at Full when every changed file traces, by content, to the author's own
 * unheld file-tool writes, and holds everything else until a person approves (DOR-4528).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { setMarkedFullActivity } from '../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { isApprovedByPath } from '../../extension-load-policy.js';
import { grantsDigestOf } from '../extension-path-trust.js';
import { notePathTrustEdits, notePersonApproval } from '../path-trust-edits.js';
import { noteWriteDone, noteWriteStarting, resetPathTrustWriters } from '../path-trust-writers.js';

const manifest = {
  id: 'desk',
  name: 'Desk',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
} as ExtensionRecord['manifest'];

describe('path-trust edits traced file by file', () => {
  const emit = vi.fn();
  let root: string;
  let home: string;
  let folder: string;
  let dorkHome: string;
  let atFull: boolean;
  let call = 0;
  let approvals: {
    approvedToRun: string[];
    approvedSources: Record<
      string,
      { path: string; authorHome: string; grants: string; digest?: string }
    >;
  };
  const copyAt = (currentDigest: string) =>
    ({
      id: 'desk',
      origin: 'user',
      path: folder,
      realPath: folder,
      scope: 'local',
      currentDigest,
      manifest,
    }) as ExtensionRecord;
  const filesOf = async () => {
    const out: Record<string, string> = {};
    for (const name of await fs.readdir(folder)) {
      const bytes = await fs.readFile(path.join(folder, name));
      out[name] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    return out;
  };
  const deps = {
    agentAtFull: async () => atFull,
    pin: (id: string, digest: string) => {
      approvals.approvedSources[id]!.digest = digest;
    },
    unpin: (id: string) => {
      delete approvals.approvedSources[id]!.digest;
    },
    filesOf,
  };
  const scan = (digest: string) => notePathTrustEdits([copyAt(digest)], approvals, dorkHome, deps);
  const runs = (digest: string) => isApprovedByPath(copyAt(digest), approvals);
  /** A write a noted file tool makes: noted, written as asked, completed. */
  const toolWrite = async (rel: string, text: string, held = false) => {
    const id = `call-${++call}`;
    const file = path.join(folder, rel);
    await noteWriteStarting(id, { file, agentHome: home, held }, () => Buffer.from(text));
    await fs.writeFile(file, text);
    await noteWriteDone(id);
  };
  /** What a person's yes writes for a held path-trust copy: no digest, and its files recorded. */
  const approve = async (digest: string) => {
    delete approvals.approvedSources.desk!.digest;
    await notePersonApproval(dorkHome, copyAt(digest), digest, filesOf);
  };
  const seenFile = () => path.join(dorkHome, 'extension-data', 'path-trust-seen.json');
  /** A write nothing noted: a shell, another runtime, a program outside DorkOS. */
  const unseenWrite = (rel: string, text: string) => fs.writeFile(path.join(folder, rel), text);

  beforeEach(async () => {
    emit.mockReset();
    resetLiveOutsiderTurns();
    resetPathTrustWriters();
    setMarkedFullActivity({ emit } as never);
    atFull = true;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pt-trace-')));
    home = path.join(root, 'ana');
    folder = path.join(home, '.dork', 'extensions', 'desk');
    dorkHome = path.join(root, 'dork');
    await fs.mkdir(folder, { recursive: true });
    await unseenWrite('server.ts', 'v1');
    await unseenWrite('index.ts', 'i1');
    approvals = {
      approvedToRun: ['desk'],
      approvedSources: {
        desk: { path: folder, authorHome: home, grants: grantsDigestOf(manifest) },
      },
    };
  });
  afterEach(async () => {
    setMarkedFullActivity(undefined);
    resetLiveOutsiderTurns();
    resetPathTrustWriters();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('the author’s own unheld edit runs and writes one Activity line', async () => {
    await scan('sha256:1');
    await toolWrite('server.ts', 'v2');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('the author’s edit loop keeps running edit after edit', async () => {
    await scan('sha256:1');
    for (let v = 2; v <= 4; v += 1) {
      await toolWrite('server.ts', `v${v}`);
      await scan(`sha256:${v}`);
      expect(runs(`sha256:${v}`)).toBe(true);
    }
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('an edit from the author’s held turn waits', async () => {
    await scan('sha256:1');
    await toolWrite('server.ts', 'v2', true);
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });

  it('a clean edit to one file does not carry an unseen change to another', async () => {
    await scan('sha256:1');
    await toolWrite('index.ts', 'i2');
    await unseenWrite('server.ts', 'payload');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a held edit stays held through the author’s next clean edit, until a person approves', async () => {
    await scan('sha256:1');
    await unseenWrite('server.ts', 'v2');
    await scan('sha256:2');
    await toolWrite('server.ts', 'v3');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    await approve('sha256:3');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
    await toolWrite('server.ts', 'v4');
    await scan('sha256:4');
    expect(runs('sha256:4')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('an unseen change after a person’s yes waits: the yes covered only what they saw', async () => {
    await scan('sha256:1');
    await unseenWrite('server.ts', 'v2');
    await scan('sha256:2');
    await approve('sha256:2');
    await unseenWrite('server.ts', 'payload');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a held copy found unpinned with no recorded yes is traced, and held again', async () => {
    await scan('sha256:1');
    await unseenWrite('server.ts', 'v2');
    await scan('sha256:2');
    // Unpinned, but not through a person's yes.
    delete approvals.approvedSources.desk!.digest;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });

  it('an unreadable record holds every copy it can no longer vouch for, until a person approves', async () => {
    await scan('sha256:1');
    await fs.writeFile(seenFile(), '{');
    await toolWrite('server.ts', 'v2');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    // Rewritten whole, but what it held is gone: a copy it no longer names still waits.
    expect(JSON.parse(await fs.readFile(seenFile(), 'utf8')).distrustNew).toBe(true);
    await approve('sha256:2');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(true);
    await toolWrite('server.ts', 'v3');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
  });

  it('a change made below Full is traced too once the agent is raised', async () => {
    await scan('sha256:1');
    atFull = false;
    await unseenWrite('server.ts', 'payload');
    await scan('sha256:2');
    atFull = true;
    await scan('sha256:2');
    await toolWrite('index.ts', 'i2');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a clean edit made below Full runs with the next clean edit at Full', async () => {
    await scan('sha256:1');
    atFull = false;
    await toolWrite('server.ts', 'v2');
    await scan('sha256:2');
    atFull = true;
    await scan('sha256:2');
    await toolWrite('index.ts', 'i2');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keeps the trusted files on disk, so a restart still traces from them', async () => {
    await scan('sha256:1');
    const saved = JSON.parse(
      await fs.readFile(path.join(dorkHome, 'extension-data', 'path-trust-seen.json'), 'utf8')
    );
    expect(saved.trusted.desk.digest).toBe('sha256:1');
    expect(Object.keys(saved.trusted.desk.files).sort()).toEqual(['index.ts', 'server.ts']);
    // A fresh process has no record of writes, so an edit made before it is no one's.
    resetPathTrustWriters();
    await unseenWrite('server.ts', 'v2');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });
});
