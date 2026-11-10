import { it, expect } from 'vitest';
import { createOpenCodeEventContext, mapOpenCodeEvent } from '../events/event-mapper.js';
import {
  assistantMessage,
  messageUpdated,
  partDelta,
  partUpdated,
  textPart,
  toolPart,
  toolStateCompleted,
  CREATED_AT,
  COMPLETED_AT,
  OC_SESSION_A,
} from './opencode-sse-fixtures.js';
it('keeps native request counts and boundaries with one observed first token', () => {
  const ctx = createOpenCodeEventContext('session', () => 100);
  const assistant = assistantMessage(OC_SESSION_A);
  const start = { ...assistant, time: { created: 50 } };
  expect(
    mapOpenCodeEvent(messageUpdated(start), ctx).find((e) => e.type === 'model_request')?.data
  ).toMatchObject({ startedAt: 50, phase: 'start', requestId: assistant.id });
  mapOpenCodeEvent(partUpdated(textPart(OC_SESSION_A, 'p', '')), ctx);
  const delta = partDelta(OC_SESSION_A, 'p', 'hello', { messageID: assistant.id, field: 'text' });
  expect(mapOpenCodeEvent(delta, ctx).find((e) => e.type === 'model_request')?.data).toMatchObject({
    firstTokenAt: 100,
    phase: 'first_token',
  });
  expect(mapOpenCodeEvent(delta, ctx).filter((e) => e.type === 'model_request')).toEqual([]);
  const end = { ...assistant, time: { created: 50, completed: 200 } };
  expect(
    mapOpenCodeEvent(messageUpdated(end), ctx).find((e) => e.type === 'model_request')?.data
  ).toMatchObject({ startedAt: 50, endedAt: 200, firstTokenAt: 100, phase: 'end' });
  expect(
    mapOpenCodeEvent(messageUpdated(end), ctx).filter((e) => e.type === 'model_request')
  ).toEqual([]);
});

it('preserves native tool timing even when the first snapshot is already complete', () => {
  const ctx = createOpenCodeEventContext('s', () => 9);
  mapOpenCodeEvent(messageUpdated(assistantMessage(OC_SESSION_A)), ctx);
  const events = mapOpenCodeEvent(
    partUpdated(toolPart(OC_SESSION_A, 'call', 'read', toolStateCompleted({}, 'ok'))),
    ctx
  );
  for (const event of events)
    expect(event.data).toMatchObject({ startedAt: CREATED_AT, endedAt: COMPLETED_AT });
});
