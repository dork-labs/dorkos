import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sql } from '@dorkos/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { SessionEventStore } from '../session-event-store.js';
import { mapSdkMessage } from '../../runtimes/claude-code/sdk/sdk-event-mapper.js';
import type { AgentSession, ToolState } from '../../runtimes/claude-code/agent-types.js';
import { runInDispatch } from '../../../lib/dispatch-context.js';
import { feedProjector } from '../session-event-normalizer.js';
import { SessionStateProjector } from '../session-state-projector.js';
import { latestClaudeRoomServerFailure } from '../history/latest-room-failure.js';

const failed = (): SessionEvent[] => [
  { type: 'turn_start', seq: 10, roomMessage: { roomId: 'room', entryId: 'prior-work' } },
  {
    type: 'error',
    seq: 14,
    code: 'server_error',
    category: 'execution_error',
    message: 'Upstream error',
  },
  {
    type: 'error',
    seq: 18,
    code: 'error_during_execution',
    category: 'execution_error',
    message: 'Upstream error',
    reason: 'claude-server-error-terminal',
    sourceDispatchId: 'prior-dispatch',
  },
  { type: 'turn_end', seq: 22, terminalReason: 'error' },
];
function fixture(events = failed()) {
  const db = createTestDb();
  const store = new SessionEventStore(db);
  store.appendTurn('seat', events);
  return {
    db,
    store,
    read: () => latestClaudeRoomServerFailure(store.readLatestTurnStrict('seat'), 'room'),
  };
}
describe('strict prior room failure evidence', () => {
  it('qualifies only the actual SDK → normalizer → record projector/store failure chain', async () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('seat');
    projector.enablePersistence(store, 'record');
    const session = { hasStarted: true, sdkSessionId: 'seat' } as AgentSession;
    const tools = {
      toolNameById: new Map(),
      resolvedResultIds: new Set(),
      toolInputReceived: new Set(),
    } as unknown as ToolState;
    const messages = [
      {
        type: 'assistant',
        error: 'server_error',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: upstream unavailable' }],
        },
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['API Error: upstream unavailable'],
      },
    ];
    async function* mapped() {
      for (const message of messages) {
        yield* mapSdkMessage(
          message as Parameters<typeof mapSdkMessage>[0],
          session,
          'seat',
          tools
        );
      }
    }
    await runInDispatch(
      { dispatchId: 'prior-dispatch', origin: 'room', entryId: 'prior-work' },
      () =>
        feedProjector(projector, mapped(), {
          userMessage: 'The previous work, never to replay',
          roomMessage: { roomId: 'room', entryId: 'prior-work' },
        })
    );
    const events = store.readLatestTurnStrict('seat');
    expect(events?.at(-1)).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
    expect(latestClaudeRoomServerFailure(events, 'room')).toMatchObject({
      entryId: 'prior-work',
      dispatchId: 'prior-dispatch',
    });
    expect(projector.getStatus().lifecycle).toBe('error');
  });

  it('retains real SQLite record-mode sequence gaps and exact terminal watermark', () => {
    expect(fixture().read()).toEqual({
      startSeq: 10,
      endSeq: 22,
      entryId: 'prior-work',
      dispatchId: 'prior-dispatch',
    });
  });
  it.each(['rate_limit', 'invalid_request', 'authentication_failed', 'unknown_future_error'])(
    'refuses mixed %s even with a terminal marker',
    (code) => {
      const events = failed();
      events.splice(2, 0, { type: 'error', seq: 16, code, message: 'Other cause' });
      expect(fixture(events).read()).toBeNull();
    }
  );
  it('does not treat the wrapper marker alone as authority', () => {
    expect(fixture(failed().filter((event) => event.seq !== 14)).read()).toBeNull();
  });
  it('refuses uncorrelated historical generic terminal wrappers', () => {
    const events = failed();
    delete (events[2] as Extract<SessionEvent, { type: 'error' }>).reason;
    expect(fixture(events).read()).toBeNull();
  });
  it('refuses malformed stored payload instead of skipping it', () => {
    const { db, read } = fixture();
    db.run(sql`UPDATE session_events SET payload = '{bad' WHERE session_id = 'seat' AND seq = 14`);
    expect(read()).toBeNull();
  });
  it('refuses missing start or end and wrong room provenance', () => {
    expect(fixture(failed().slice(1)).read()).toBeNull();
    expect(fixture(failed().slice(0, -1)).read()).toBeNull();
    const { store } = fixture();
    expect(
      latestClaudeRoomServerFailure(store.readLatestTurnStrict('seat'), 'other-room')
    ).toBeNull();
  });
  it.each([false, true])(
    'refuses a later %s-complete turn rather than recovering the older failure',
    (complete) => {
      const { store, read } = fixture();
      store.appendTurn('seat', [
        { type: 'turn_start', seq: 30, roomMessage: { roomId: 'room', entryId: 'later-work' } },
        ...(complete ? [{ type: 'turn_end', seq: 33 } as SessionEvent] : []),
      ]);
      expect(read()).toBeNull();
    }
  );
  it('refuses an interrupted prior turn', () => {
    const events = failed();
    events[3] = {
      type: 'turn_end',
      seq: 22,
      terminalReason: 'aborted_streaming',
      stopWasRequested: true,
    };
    expect(fixture(events).read()).toBeNull();
  });
});
