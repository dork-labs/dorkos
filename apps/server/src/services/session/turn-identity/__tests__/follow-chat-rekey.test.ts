/**
 * `followChatRekey` (DOR-5046): the in-memory redirect answers first, a
 * registered durable record answers when no projector knows the id, and a
 * durable record that fails never breaks the lookup. The durable record here is
 * a stand-in, because this domain may not import the work graph (the
 * `work-graph/stay-out` lint rule); the real one is driven over a real database
 * in `services/work-graph/__tests__/work-graph-write-sites.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import {
  disposeProjector,
  getOrCreateProjector,
  rekeyProjector,
} from '../../session-state-projector.js';
import { followChatRekey, registerDurableRekeyResolver } from '../follow-chat-rekey.js';

const FIRST_ID = 'follow-first-id';
const LIVE_ID = 'follow-live-id';
const RECORDED_ID = 'follow-recorded-id';

let unregister: Array<() => void> = [];

/** Register a durable record for this test only. */
function register(resolver: (sessionId: string) => string): void {
  unregister.push(registerDurableRekeyResolver(resolver));
}

afterEach(() => {
  for (const stop of unregister) stop();
  unregister = [];
  disposeProjector(LIVE_ID);
  vi.restoreAllMocks();
});

describe('followChatRekey', () => {
  it('answers the id as given when nothing records a re-key', () => {
    expect(followChatRekey(FIRST_ID)).toBe(FIRST_ID);
  });

  it('asks the durable record when no projector knows the id', () => {
    register((id) => (id === FIRST_ID ? RECORDED_ID : id));
    expect(followChatRekey(FIRST_ID)).toBe(RECORDED_ID);
  });

  it('follows the in-memory redirect first, without asking the durable record', () => {
    const durable = vi.fn(() => RECORDED_ID);
    register(durable);
    getOrCreateProjector(FIRST_ID);
    rekeyProjector(FIRST_ID, LIVE_ID);
    expect(followChatRekey(FIRST_ID)).toBe(LIVE_ID);
    expect(followChatRekey(LIVE_ID)).toBe(LIVE_ID);
    expect(durable).not.toHaveBeenCalled();
  });

  it('answers the id as given, and logs only the id, when the durable record throws', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    register(() => {
      throw new Error('the record is unreadable');
    });
    expect(followChatRekey(FIRST_ID)).toBe(FIRST_ID);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual({ sessionId: FIRST_ID });
  });

  it('consults a resolver registered twice once, and forgets it when unregistered', () => {
    const durable = vi.fn(() => RECORDED_ID);
    register(durable);
    register(durable);
    expect(followChatRekey(FIRST_ID)).toBe(RECORDED_ID);
    expect(durable).toHaveBeenCalledTimes(1);
    for (const stop of unregister) stop();
    expect(followChatRekey(FIRST_ID)).toBe(FIRST_ID);
  });

  it('keeps the newer resolver when an older one is unregistered', () => {
    const stopOlder = registerDurableRekeyResolver(() => 'older');
    register(() => RECORDED_ID);
    stopOlder();
    expect(followChatRekey(FIRST_ID)).toBe(RECORDED_ID);
  });
});
