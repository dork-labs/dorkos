import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { setMarkedFullActivity } from '../../../core/turn-power/full-autonomy.js';
import { isApprovedByPath } from '../../extension-load-policy.js';
import { grantsDigestOf } from '../extension-path-trust.js';
import { notePathTrustEdits } from '../path-trust-edits.js';

const HOME = '/agents/ana';
const manifest = {
  id: 'desk',
  name: 'Desk',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
} as ExtensionRecord['manifest'];

const copyAt = (currentDigest: string) =>
  ({
    id: 'desk',
    origin: 'user',
    path: `${HOME}/.dork/extensions/desk`,
    realPath: `${HOME}/.dork/extensions/desk`,
    scope: 'local',
    currentDigest,
    manifest,
  }) as ExtensionRecord;

describe('notePathTrustEdits', () => {
  const emit = vi.fn();
  let dorkHome: string;
  let atFull: boolean;
  let approvals: {
    approvedToRun: string[];
    approvedSources: Record<
      string,
      { path: string; authorHome: string; grants: string; digest?: string }
    >;
  };
  const deps = {
    agentAtFull: async () => atFull,
    pin: (id: string, digest: string) => {
      approvals.approvedSources[id]!.digest = digest;
    },
    unpin: (id: string) => {
      delete approvals.approvedSources[id]!.digest;
    },
  };
  const scan = (digest: string) => notePathTrustEdits([copyAt(digest)], approvals, dorkHome, deps);
  /** Whether this copy's files may run under the approval as it stands. */
  const runs = (digest: string) => isApprovedByPath(copyAt(digest), approvals);

  beforeEach(async () => {
    emit.mockReset();
    setMarkedFullActivity({ emit } as never);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'path-trust-'));
    atFull = true;
    approvals = {
      approvedToRun: ['desk'],
      approvedSources: {
        desk: { path: copyAt('x').path, authorHome: HOME, grants: grantsDigestOf(manifest) },
      },
    };
  });
  afterEach(async () => {
    setMarkedFullActivity(undefined);
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('at Full: an edit runs and writes one line; first sight and no change write none', async () => {
    await scan('sha256:1');
    await scan('sha256:1');
    expect(emit).not.toHaveBeenCalled();
    await scan('sha256:2');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({ actorId: HOME, resourceId: 'extension.edit' });
    expect(runs('sha256:2')).toBe(true);
  });

  it('lowered: the edit made before the scan does not run, and neither does a later one', async () => {
    await scan('sha256:1');
    atFull = false;
    await scan('sha256:2');
    expect(runs('sha256:1')).toBe(true);
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('raised again: the held edit stays held until a person approves', async () => {
    await scan('sha256:1');
    atFull = false;
    await scan('sha256:2');
    atFull = true;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('raised again: a new edit at Full lifts the pin, runs and logs', async () => {
    await scan('sha256:1');
    atFull = false;
    await scan('sha256:2');
    atFull = true;
    await scan('sha256:2');
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('lowered, then edited, then raised: the edit stays held, and the next edit runs', async () => {
    await scan('sha256:1');
    atFull = false;
    await scan('sha256:1');
    atFull = true;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a person’s yes on the held edit is not undone by the next scan', async () => {
    await scan('sha256:1');
    atFull = false;
    await scan('sha256:2');
    // What approving writes for a copy that keeps path trust: no digest.
    delete approvals.approvedSources.desk!.digest;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a level that cannot be read pins', async () => {
    await scan('sha256:1');
    deps.agentAtFull = async () => {
      throw new Error('unreadable');
    };
    await scan('sha256:1');
    expect(approvals.approvedSources.desk!.digest).toBe('sha256:1');
    deps.agentAtFull = async () => atFull;
  });

  it('boot: an edit made while down, at Full, runs once the level can be read', async () => {
    await scan('sha256:1');
    const agentAtFull = deps.agentAtFull;
    deps.agentAtFull = async () => {
      throw new Error('no runtime is registered yet');
    };
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    deps.agentAtFull = agentAtFull;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('boot: an edit made while down, below Full, stays held once the level can be read', async () => {
    await scan('sha256:1');
    const agentAtFull = deps.agentAtFull;
    deps.agentAtFull = async () => {
      throw new Error('no runtime is registered yet');
    };
    await scan('sha256:2');
    deps.agentAtFull = agentAtFull;
    atFull = false;
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('sees an edit made while the server was down', async () => {
    await scan('sha256:1');
    // A fresh process reads the digest back from disk: nothing here is kept in memory.
    await scan('sha256:2');
    const saved = JSON.parse(
      await fs.readFile(path.join(dorkHome, 'extension-data', 'path-trust-seen.json'), 'utf8')
    );
    expect(saved).toEqual({ digests: { desk: 'sha256:2' }, below: [] });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('leaves a copy pinned to its files alone', async () => {
    approvals.approvedSources.desk!.digest = 'sha256:1';
    await scan('sha256:2');
    expect(emit).not.toHaveBeenCalled();
  });
});
