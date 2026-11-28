/**
 * DOR-3202: a card nothing holds must not leave a Stop that does nothing.
 *
 * A turn can end with a card still listed (its runtime's withdrawal never
 * drained). The session then reads `blocked`, the chat offers Stop, and the
 * runtime answers that Stop with `not-running` because it holds no turn. These
 * cases pin the two halves of the fix: the Stop withdraws what nothing holds,
 * and an entry past its ceiling no longer latches a later turn at `blocked`.
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { feedProjector } from '../../session-event-normalizer.js';
import { SessionStateProjector } from '../../session-state-projector.js';
import { SESSIONS } from '../../../../config/constants.js';
import { withdrawAsksAfterIdleStop } from '../withdrawn-asks.js';

/** An approval the agent stopped on, raised `agoMs` ago. */
function approvalFor(toolCallId: string, agoMs = 0): StreamEvent {
  return {
    type: 'approval_required',
    data: {
      toolCallId,
      toolName: 'Bash',
      input: '{"command":"ls"}',
      startedAt: Date.now() - agoMs,
      timeoutMs: 600_000,
      hasSuggestions: false,
    },
  };
}

/** A turn that raises the card and then ends cleanly, leaving it listed. */
async function strandCard(projector: SessionStateProjector, card: StreamEvent): Promise<void> {
  async function* turn(): AsyncIterable<StreamEvent> {
    yield card;
    yield { type: 'done', data: { sessionId: 'stranded' } };
  }
  await feedProjector(projector, turn());
}

const runtimeWithNoHelpers = { liveHelperIds: () => [] };
const notRunning = { outcome: 'not-running', reason: 'no-open-turn', runtime: 'fake' } as const;

describe('Stop on a card nothing holds (DOR-3202)', () => {
  it('withdraws it as cancelled and settles the session idle', async () => {
    const projector = new SessionStateProjector('stranded-1');
    await strandCard(projector, approvalFor('tool-1'));
    expect(projector.getStatus().lifecycle).toBe('blocked');

    withdrawAsksAfterIdleStop(projector, notRunning, runtimeWithNoHelpers, 'stranded-1');

    expect(projector.getPendingInteractions()).toEqual([]);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  it('leaves a card alone when the Stop reached a running turn', async () => {
    const projector = new SessionStateProjector('stranded-2');
    await strandCard(projector, approvalFor('tool-2'));

    withdrawAsksAfterIdleStop(
      projector,
      { outcome: 'acked', runtime: 'fake' },
      runtimeWithNoHelpers,
      'stranded-2'
    );

    expect(projector.getPendingInteractions().map((p) => p.id)).toEqual(['tool-2']);
  });

  it('leaves a card alone while a helper the runtime still runs may own it', async () => {
    const projector = new SessionStateProjector('stranded-3');
    await strandCard(projector, approvalFor('tool-3'));

    withdrawAsksAfterIdleStop(projector, notRunning, { liveHelperIds: () => ['helper'] }, 'x');

    expect(projector.getPendingInteractions().map((p) => p.id)).toEqual(['tool-3']);
  });
});

describe('an entry past its ceiling does not hold a later turn at blocked (DOR-3202)', () => {
  it('settles the turn idle once the stranded entry has expired', async () => {
    const projector = new SessionStateProjector('stranded-4');
    await strandCard(
      projector,
      approvalFor('tool-4', SESSIONS.INTERACTION_PARK_CEILING_MS + 1_000)
    );

    expect(projector.hasPendingInteractions()).toBe(false);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });
});
