/**
 * The stopped-timers note (DOR-3755) through the real dispatcher: it rides the
 * next turn in its own block, beside a cutoff owed at the same time, comes back
 * when that turn fails to start, and goes with a session that went away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AdditionalContext } from '@dorkos/shared/additional-context';

import {
  dispatchMessage,
  noteSessionOrphaned,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../../message-dispatcher.js';
import { resetPermissionGate } from '../../../core/capabilities/permission-enforcement.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import { noteTurnCutoff, resetTurnCutoffs } from '../turn-cutoff.js';
import { noteTimersStopped, resetTimersStopped, takeTimersStopped } from '../timers-stopped.js';

const AT = Date.UTC(2026, 10, 1, 20, 48, 7);

let session: string;
let counter = 0;
let runtime: FakeAgentRuntime;

/** The context bag each turn was dispatched with, in order. */
function bags(): AdditionalContext[] {
  return runtime.sendMessage.mock.calls.map(
    (call) => (call[2] as { additionalContext?: AdditionalContext }).additionalContext ?? []
  );
}

/** Run one turn that ends at once. */
async function turn(content: string): Promise<void> {
  runtime.withScenarios([
    async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  ]);
  await dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: session,
    clientId: 'window-a',
    content,
    projector: getOrCreateProjector(session),
    runtime,
  }).catch(() => undefined);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const kinds = (bag: AdditionalContext) => bag.map((entry) => entry.kind);

beforeEach(() => {
  counter += 1;
  session = `00000000-0000-4000-b000-${String(counter).padStart(12, '0')}`;
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
});

afterEach(() => {
  resetMessageDispatcher();
  resetPermissionGate();
  resetTurnCutoffs();
  resetTimersStopped();
  disposeProjector(session);
  vi.restoreAllMocks();
});

describe('the stopped-timers note', () => {
  it('rides the next turn in its own block, beside a cutoff owed at the same time', async () => {
    noteTurnCutoff(session, { windowMs: 600_000, neverStarted: false });
    noteTimersStopped(session, { timers: 1, at: AT });

    await turn('first');
    await turn('second');

    const [first, second] = bags();
    expect(kinds(first!)).toEqual(expect.arrayContaining(['turn_cutoff', 'timers_stopped']));
    expect(first!.find((entry) => entry.kind === 'timers_stopped')).toEqual({
      kind: 'timers_stopped',
      scope: 'per-turn',
      data: { timers: 1, at: AT },
    });
    // Taken, not peeked: only one turn carries it.
    expect(kinds(second!)).not.toContain('timers_stopped');
  });

  it('comes back when the turn that took it fails to start', async () => {
    noteTimersStopped(session, { timers: 2, at: AT });
    runtime.sendMessage.mockImplementationOnce(() => {
      throw new Error('the runtime refused to start');
    });

    await turn('this one never starts');
    await turn('this one runs');

    const next = runtime.sendMessage.mock.calls.find((call) => call[1] === 'this one runs')!;
    const bag = (next[2] as { additionalContext?: AdditionalContext }).additionalContext ?? [];
    expect(bag.filter((entry) => entry.kind === 'timers_stopped')).toEqual([
      expect.objectContaining({ data: { timers: 2, at: AT } }),
    ]);
  });

  it('goes with a session that went away', () => {
    noteTimersStopped(session, { timers: 1, at: AT });
    noteSessionOrphaned(session);
    sweepOrphanedMessageQueues({ isLive: () => false });

    expect(takeTimersStopped(session)).toBeNull();
  });
});
