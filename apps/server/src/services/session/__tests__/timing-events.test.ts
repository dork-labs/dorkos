import { createTestDb } from '@dorkos/test-utils/db';
import { SessionStateProjector, type RawSessionEvent } from '../session-state-projector.js';
import { SessionEventStore } from '../session-event-store.js';
import { reconstructHistoryFromEvents } from '../event-log-history.js';
import { it, expect } from 'vitest';
import { toRawSessionEvent } from '../session-event-normalizer.js';
import { ModelRequestEventSchema, ToolCallEventSchema } from '@dorkos/shared/schemas';
import { SessionEventSchema } from '@dorkos/shared/session-stream';
import { isRecordedEvent } from '../projector-persistence.js';
it('preserves tool and request timings through the durable boundary', () => {
  const call = toRawSessionEvent({
    type: 'tool_result',
    data: { toolCallId: 'a', toolName: 'Read', status: 'complete', startedAt: 10, endedAt: 20 },
  });
  expect(call).toMatchObject({ startedAt: 10, endedAt: 20 });
  const event = toRawSessionEvent({
    type: 'model_request',
    data: {
      requestId: 'r',
      phase: 'end',
      firstTokenAt: 5,
      endedAt: 10,
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  expect(SessionEventSchema.parse({ ...event, seq: 1 })).toMatchObject({
    requestId: 'r',
    firstTokenAt: 5,
    endedAt: 10,
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(isRecordedEvent(event!)).toBe(true);
});
it('rejects invalid readings instead of accepting them through another union member', () => {
  expect(ModelRequestEventSchema.safeParse({ phase: 'end', endedAt: NaN }).success).toBe(false);
  expect(
    ToolCallEventSchema.safeParse({
      toolCallId: 'a',
      toolName: 'Read',
      status: 'running',
      startedAt: -1,
    }).success
  ).toBe(false);
  expect(toRawSessionEvent({ type: 'model_request', data: { phase: 'bad' } } as never)).toBeNull();
});

it('keeps model timing in Claude record mode without copying tool contents', () => {
  const store = new SessionEventStore(createTestDb());
  const projector = new SessionStateProjector('timing');
  projector.enablePersistence(store, 'record');
  projector.ingest({ type: 'turn_start', userMessage: 'sample' } as RawSessionEvent);
  projector.ingest(
    toRawSessionEvent({
      type: 'model_request',
      data: { phase: 'end', requestId: 'request', firstTokenAt: 10, endedAt: 20 },
    })!
  );
  projector.ingest(
    toRawSessionEvent({
      type: 'tool_result',
      data: {
        toolCallId: 'tool',
        toolName: 'Read',
        status: 'complete',
        result: 'private tool content',
        startedAt: 10,
        endedAt: 20,
      },
    })!
  );
  projector.ingest({ type: 'turn_end' });
  const rows = store.readAll('timing');
  expect(rows.map((e) => e.type)).toEqual(['turn_start', 'model_request', 'turn_end']);
  expect(rows[1]).toMatchObject({ requestId: 'request', firstTokenAt: 10, endedAt: 20 });
  expect(JSON.stringify(rows)).not.toContain('private tool content');
});
it('restores tool timestamps when log-backed history is reopened', () => {
  const rows = [
    { type: 'turn_start', seq: 1, userMessage: 'sample' },
    {
      type: 'tool_call',
      seq: 2,
      toolCallId: 'a',
      toolName: 'Read',
      status: 'running',
      startedAt: 10,
    },
    {
      type: 'tool_result',
      seq: 3,
      toolCallId: 'a',
      toolName: 'Read',
      status: 'complete',
      startedAt: 10,
      endedAt: 20,
    },
    { type: 'turn_end', seq: 4 },
  ];
  const history = reconstructHistoryFromEvents(
    rows as Parameters<typeof reconstructHistoryFromEvents>[0]
  );
  const tool = history.flatMap((m) => m.toolCalls ?? []).find((p) => p.toolCallId === 'a');
  expect(tool).toMatchObject({ startedAt: 10, endedAt: 20 });
});
