import { AppServerTurnMapper } from '../notification-mapper.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { it, expect } from 'vitest';
import { codexRequestUsage } from '../request-timing.js';
import type { ServerNotification } from '../protocol/methods.js';
it('reports last-request counts, never cumulative turn counts or guessed timestamps', () => {
  const owner = {};
  const event = {
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 4 },
        total: { inputTokens: 100, outputTokens: 40 },
      },
    },
  } as ServerNotification;
  expect(codexRequestUsage(owner, event)).toEqual([
    { type: 'model_request', data: { phase: 'usage', inputTokens: 10, outputTokens: 4 } },
  ]);
  expect(codexRequestUsage(owner, event)).toEqual([]);
  expect(codexRequestUsage({}, event)).toHaveLength(1);
});

it('times actual starts and completions while leaving synthetic starts unknown', () => {
  const mapper = new AppServerTurnMapper(createCodexEventContext('s', { now: () => 50 }));
  const item = { type: 'webSearch', id: 'a', query: 'sample' };
  expect(
    mapper.map({ method: 'item/started', params: { item, startedAtMs: 10 } })[0].data
  ).toMatchObject({ startedAt: 10 });
  expect(
    mapper.map({ method: 'item/completed', params: { item, completedAtMs: 30 } }).at(-1)?.data
  ).toMatchObject({ startedAt: 10, endedAt: 30 });
  const late = { ...item, id: 'b' };
  const events = mapper.map({
    method: 'item/completed',
    params: { item: late, completedAtMs: 40 },
  });
  expect(events[0].data).not.toHaveProperty('startedAt');
  expect(events.at(-1)?.data).toHaveProperty('endedAt', 40);
});
