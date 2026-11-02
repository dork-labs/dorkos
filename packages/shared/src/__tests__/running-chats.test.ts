import { describe, expect, it } from 'vitest';
import { RunningChatsResponseSchema } from '../running-chats.js';

const empty = { total: 0, agents: [], unassigned: { count: 0, privateCount: 0, chats: [] } };

describe('running-chats capacity contract', () => {
  it.each([
    { live: 0, available: 50, message: null },
    {
      live: 50,
      available: 0,
      message: 'All 50 chats are busy. Wait for one to finish, then try again.',
    },
  ])('preserves the admission report even when no chat is visible: %j', (state) => {
    const capacity = [{ runtime: 'claude-code', limit: 50, records: 50, ...state }];
    expect(RunningChatsResponseSchema.parse({ ...empty, capacity }).capacity).toEqual(capacity);
  });

  it('accepts readers and backends that do not report a cap', () => {
    expect(RunningChatsResponseSchema.parse(empty)).toEqual(empty);
  });
});
