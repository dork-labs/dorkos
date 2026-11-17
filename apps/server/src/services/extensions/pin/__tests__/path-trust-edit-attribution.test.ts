/**
 * A path-trust copy's edit runs at Full only when it can be tied to its author's own turn, and
 * that turn held no mark. Uses the real turn record, so nothing here is a stand-in for the rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { isApprovedByPath } from '../../extension-load-policy.js';
import { grantsDigestOf } from '../extension-path-trust.js';
import type { TurnMarks } from '../../../core/turn-power/turn-marks.js';
import { notePathTrustEdits } from '../path-trust-edits.js';
import { noteExtensionWrite, resetPathTrustWriters } from '../path-trust-writers.js';

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

/** A turn that runs until `end` is called, counted with these marks while it does. */
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

describe('path-trust edits are tied to the turn that made them', () => {
  const emit = vi.fn();
  let dorkHome: string;
  let approvals: {
    approvedToRun: string[];
    approvedSources: Record<
      string,
      { path: string; authorHome: string; grants: string; digest?: string }
    >;
  };
  // The level and the pin only: who wrote the files is the server's own record.
  const deps = {
    agentAtFull: async () => true,
    pin: (id: string, digest: string) => {
      approvals.approvedSources[id]!.digest = digest;
    },
    unpin: (id: string) => {
      delete approvals.approvedSources[id]!.digest;
    },
  };
  const scan = (digest: string) => notePathTrustEdits([copyAt(digest)], approvals, dorkHome, deps);
  const runs = (digest: string) => isApprovedByPath(copyAt(digest), approvals);

  beforeEach(async () => {
    emit.mockReset();
    resetLiveOutsiderTurns();
    resetPathTrustWriters();
    setMarkedFullActivity({ emit } as never);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'path-trust-attr-'));
    approvals = {
      approvedToRun: ['desk'],
      approvedSources: {
        desk: { path: copyAt('x').path, authorHome: HOME, grants: grantsDigestOf(manifest) },
      },
    };
  });
  afterEach(async () => {
    setMarkedFullActivity(undefined);
    resetLiveOutsiderTurns();
    resetPathTrustWriters();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('created unmarked, then edited while a marked turn runs: the edit waits', async () => {
    await scan('sha256:1');
    const turn = turnWith({ outsider: true });
    await turn.start();
    await scan('sha256:2');
    await turn.finish();
    expect(runs('sha256:1')).toBe(true);
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('created unmarked, then edited by a marked turn that has ended: the edit waits', async () => {
    await scan('sha256:1');
    const turn = turnWith({ outsider: true });
    await turn.start();
    await turn.finish();
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('an edit no turn can be tied to waits', async () => {
    await scan('sha256:1');
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('the author’s own unheld edit runs and writes one Activity line', async () => {
    await scan('sha256:1');
    write({ held: false });
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('an edit from the author’s held turn waits', async () => {
    await scan('sha256:1');
    write({ held: true });
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });

  it('an edit beside another agent’s write to the same copy waits', async () => {
    await scan('sha256:1');
    write({ held: false });
    write({ held: false, agentHome: '/agents/bo' });
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });

  it('an author write to another copy does not vouch for this one', async () => {
    await scan('sha256:1');
    write({ held: false, file: `${HOME}/.dork/extensions/notes/server.ts` });
    await scan('sha256:2');
    expect(runs('sha256:2')).toBe(false);
  });

  it('a held edit stays held through the author’s next clean edit, until a person approves', async () => {
    await scan('sha256:1');
    await scan('sha256:2');
    write({ held: false });
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    // What approving writes for a copy that keeps path trust: no digest.
    delete approvals.approvedSources.desk!.digest;
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(true);
    write({ held: false });
    await scan('sha256:4');
    expect(runs('sha256:4')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a marked turn that ran while nothing changed still holds the next edit', async () => {
    await scan('sha256:1');
    write({ held: false });
    await scan('sha256:2');
    const turn = turnWith({ outsider: true });
    await turn.start();
    await turn.finish();
    // Nothing changed while it ran: the next scan asks nothing, and the window stays open.
    await scan('sha256:2');
    write({ held: false });
    await scan('sha256:3');
    expect(runs('sha256:3')).toBe(false);
  });
});

/** A write the file-tool hook would note for the author, into this copy unless told otherwise. */
function write(over: { held: boolean; agentHome?: string; file?: string }): void {
  noteExtensionWrite({
    file: over.file ?? `${HOME}/.dork/extensions/desk/server.ts`,
    agentHome: over.agentHome ?? HOME,
    held: over.held,
  });
}
