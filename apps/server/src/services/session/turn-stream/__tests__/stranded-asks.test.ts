/**
 * DOR-3210: an approval card must not outlive the turn that raised it when that
 * turn fails. The runtime's own withdrawal rides an event queue nobody drains
 * once the stream has thrown, so before this fix the card stayed a live button
 * for the whole park ceiling: the room counted it as waiting on a person, the
 * Needs-you surfaces listed it, and approving it reached a turn that was gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { feedProjector } from '../../session-event-normalizer.js';
import { guardTurnErrors } from '../../trigger-turn.js';
import {
  SessionStateProjector,
  onProjectorInteractionChange,
} from '../../session-state-projector.js';
import { countAwaitingByRoom } from '../../../rooms/awaiting/room-awaiting.js';

/** An approval the agent stopped on, the way claude-code raises one. */
function approvalFor(toolCallId: string): StreamEvent {
  return {
    type: 'approval_required',
    data: {
      toolCallId,
      toolName: 'Bash',
      input: '{"command":"ls"}',
      startedAt: Date.now(),
      timeoutMs: 600_000,
      hasSuggestions: false,
    },
  };
}

/** The room session ledger, reduced to one room holding every session. */
const oneRoom = { bindingForSession: () => ({ roomId: 'room-1' }) } as unknown as Parameters<
  typeof countAwaitingByRoom
>[0];

const stopListening: Array<() => void> = [];
afterEach(() => {
  for (const stop of stopListening.splice(0)) stop();
});

/** Every interaction transition the fleet is told about, for one session. */
function watchInteractions(sessionId: string): Array<{ type: string; interactionId: string }> {
  const seen: Array<{ type: string; interactionId: string }> = [];
  stopListening.push(
    onProjectorInteractionChange((change) => {
      if (change.sessionId !== sessionId) return;
      const interactionId =
        change.type === 'pending' ? change.interaction.id : change.interactionId;
      seen.push({ type: change.type, interactionId });
    })
  );
  return seen;
}

describe('a pending approval when its turn fails (DOR-3210)', () => {
  it('is withdrawn when the runtime stream throws with the card open', async () => {
    const projector = new SessionStateProjector('dead-turn-1');
    const seen = watchInteractions('dead-turn-1');

    async function* crashes(): AsyncIterable<StreamEvent> {
      yield approvalFor('tool-1');
      throw new Error('claude process exited');
    }

    await feedProjector(
      projector,
      guardTurnErrors(projector, crashes(), () => {})
    );

    expect(projector.getPendingInteractions()).toEqual([]);
    expect(projector.hasPendingInteractions()).toBe(false);
    // The room stops counting the turn as waiting on a person…
    expect(countAwaitingByRoom(oneRoom, [projector]).get('room-1')).toBeUndefined();
    // …and the Needs-you surfaces are told the card is gone. (A session with
    // no cwd never broadcasts its `pending`, so only the ending is seen here.)
    expect(seen).toEqual([{ type: 'resolved', interactionId: 'tool-1' }]);
    expect(projector.getStatus().lifecycle).toBe('error');
  });

  it('leaves as a withdrawal inside the failed window, never as an answer', async () => {
    const projector = new SessionStateProjector('dead-turn-2');
    const ingested: Array<{ type: string; resolution?: string }> = [];
    const ingest = projector.ingest.bind(projector);
    projector.ingest = ((event: Parameters<typeof ingest>[0]) => {
      ingested.push(event as { type: string; resolution?: string });
      return ingest(event);
    }) as typeof projector.ingest;

    async function* fails(): AsyncIterable<StreamEvent> {
      yield approvalFor('tool-2');
      yield { type: 'error', data: { message: 'The agent stopped unexpectedly.' } };
      yield { type: 'done', data: { sessionId: 'dead-turn-2' } };
    }

    await feedProjector(projector, fails());

    const types = ingested.map((e) => e.type);
    const resolvedAt = types.indexOf('interaction_resolved');
    // Before the window closes, so the turn is persisted without a live ask.
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(resolvedAt).toBeLessThan(types.lastIndexOf('turn_end'));
    // `cancelled`, not `approved`/`denied`/`expired`: nobody answered it, and
    // nobody ran out of time on it. The turn's own error says what happened.
    expect(ingested[resolvedAt]).toMatchObject({ resolution: 'cancelled' });
  });

  it('approving afterwards changes nothing and tells nobody twice', async () => {
    const projector = new SessionStateProjector('dead-turn-3');
    const seen = watchInteractions('dead-turn-3');

    async function* crashes(): AsyncIterable<StreamEvent> {
      yield approvalFor('tool-3');
      throw new Error('stream reset');
    }
    await feedProjector(
      projector,
      guardTurnErrors(projector, crashes(), () => {})
    );

    // A window that still drew the card answers it after the turn died.
    const lateApproval: Omit<Extract<SessionEvent, { type: 'interaction_resolved' }>, 'seq'> = {
      type: 'interaction_resolved',
      id: 'tool-3',
      resolution: 'approved',
      at: Date.now(),
    };
    projector.ingest(lateApproval);

    expect(projector.getPendingInteractions()).toEqual([]);
    expect(seen.filter((c) => c.type === 'resolved')).toHaveLength(1);
  });
});

describe('a pending approval whose turn is healthy (DOR-3210)', () => {
  it('stays answerable while the turn is still waiting on it', async () => {
    const projector = new SessionStateProjector('live-turn-1');
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));

    async function* waits(): AsyncIterable<StreamEvent> {
      yield approvalFor('tool-4');
      await answered;
      yield { type: 'done', data: { sessionId: 'live-turn-1' } };
    }

    const feeding = feedProjector(projector, waits());
    await Promise.resolve();
    await Promise.resolve();

    expect(projector.getPendingInteractions().map((p) => p.id)).toEqual(['tool-4']);
    expect(countAwaitingByRoom(oneRoom, [projector]).get('room-1')).toBe(1);
    release();
    await feeding;
  });

  it('is left alone when the turn ends cleanly', async () => {
    const projector = new SessionStateProjector('live-turn-2');

    async function* endsCleanly(): AsyncIterable<StreamEvent> {
      yield approvalFor('tool-5');
      yield { type: 'done', data: { sessionId: 'live-turn-2' } };
    }
    await feedProjector(projector, endsCleanly());

    expect(projector.getPendingInteractions().map((p) => p.id)).toEqual(['tool-5']);
  });

  it('is left alone when a helper the runtime still sees may own it', async () => {
    const projector = new SessionStateProjector('live-turn-3');

    async function* fails(): AsyncIterable<StreamEvent> {
      yield {
        type: 'background_task_started',
        data: { taskId: 'helper', taskType: 'agent', startedAt: Date.now() },
      };
      yield approvalFor('tool-6');
      yield { type: 'error', data: { message: 'main thread failed' } };
      yield { type: 'done', data: { sessionId: 'live-turn-3' } };
    }
    await feedProjector(projector, fails(), { stillLive: () => ['helper'] });

    expect(projector.getPendingInteractions().map((p) => p.id)).toEqual(['tool-6']);
  });
});
