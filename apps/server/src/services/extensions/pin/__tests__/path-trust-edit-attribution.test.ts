/**
 * A path-trust copy's edit runs at Full only when it can be traced to its author's own turn, and
 * that turn was not held. Uses the real turn record, real files and the server's own write record;
 * only the digest is a label, so the scan reads the folder as the files under that label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { StreamEvent } from '@dorkos/shared/types';
import { setMarkedFullActivity } from '../../../core/turn-power/full-autonomy.js';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../../core/turn-power/live-outsider-turns.js';
import type { TurnMarks } from '../../../core/turn-power/turn-marks.js';
import { isApprovedByPath } from '../../extension-load-policy.js';
import { grantsDigestOf } from '../extension-path-trust.js';
import { notePathTrustEdits } from '../path-trust-edits.js';

const manifest = {
  id: 'desk',
  name: 'Desk',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
} as ExtensionRecord['manifest'];

/** A turn that runs until `finish`, counted with these marks while it does. */
function turnWith(marks: TurnMarks) {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => (end = resolve));
  async function* events(): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;
    await ended;
  }
  // A place no agent resolves from counts for every agent, as an unplaced turn does.
  const stream = countWhileRunning({}, marks, events());
  return {
    start: () => stream.next(),
    finish: async () => {
      end();
      for await (const _ of stream) void _;
    },
  };
}

describe('path-trust edits are traced to the turn that made them', () => {
  const emit = vi.fn();
  let root: string;
  let home: string;
  let folder: string;
  let dorkHome: string;
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
  /** The folder's files now, as the scan reads a verified snapshot of them. */
  const filesOf = async () => {
    const out: Record<string, string> = {};
    for (const name of await fs.readdir(folder)) {
      const bytes = await fs.readFile(path.join(folder, name));
      out[name] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    return out;
  };
  const deps = {
    agentAtFull: async () => true,
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
  const edit = (text: string) => fs.writeFile(path.join(folder, 'server.ts'), text);

  beforeEach(async () => {
    emit.mockReset();
    resetLiveOutsiderTurns();
    setMarkedFullActivity({ emit } as never);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pt-attr-')));
    home = path.join(root, 'ana');
    folder = path.join(home, '.dork', 'extensions', 'desk');
    dorkHome = path.join(root, 'dork');
    await fs.mkdir(folder, { recursive: true });
    await edit('v1');
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
    await fs.rm(root, { recursive: true, force: true });
  });

  it('an edit made while one of the author’s held turns runs waits', async () => {
    await scan('sha256:1');
    const turn = turnWith({ outsider: true });
    await turn.start();
    await edit('v2');
    await scan('sha256:2');
    await turn.finish();
    expect(runs('sha256:1')).toBe(true);
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('an edit made by a held turn that has since ended waits', async () => {
    await scan('sha256:1');
    const turn = turnWith({ outsider: true });
    await turn.start();
    await edit('v2');
    await turn.finish();
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('an edit no turn can be tied to waits', async () => {
    await scan('sha256:1');
    await edit('v2');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
