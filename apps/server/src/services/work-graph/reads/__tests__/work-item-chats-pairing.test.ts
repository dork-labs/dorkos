/**
 * How a ticket's `claims` and `released` edges pair into spans (DOR-4972), rule
 * by rule as `../work-item-chats.ts` writes them down, over the real edge store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { WorkLinkStore, type ClaimLinkSource } from '../../work-link-store.js';
import { pairClaimSpans } from '../work-item-chats.js';

const TICKET = { kind: 'ticket', id: 'DOR-7' } as const;
let store: WorkLinkStore;

/** Record one transition of `chat` at minute `minute`. */
function at(
  chat: string,
  relation: 'claims' | 'released',
  minute: number,
  source: ClaimLinkSource = relation === 'claims' ? 'claim-tool' : 'release-tool'
): void {
  const result = store.record({
    from: { kind: 'chat', id: chat },
    relation,
    to: TICKET,
    source,
    recordedAt: new Date(Date.UTC(2026, 10, 26, 10, minute)).toISOString(),
  });
  if (!result.ok) throw new Error(result.reason);
}

function minute(m: number): string {
  return new Date(Date.UTC(2026, 10, 26, 10, m)).toISOString();
}

function pair(currentOf: Map<string, string> = new Map()) {
  return pairClaimSpans(
    [...store.to(TICKET, 'claims'), ...store.to(TICKET, 'released')],
    currentOf
  );
}

beforeEach(() => {
  store = new WorkLinkStore({ db: createTestDb() });
});

describe('pairing claims into spans', () => {
  it('opens a span on a claim and closes it on the next release', () => {
    at('a', 'claims', 1);
    at('a', 'released', 5);
    expect(pair()).toEqual([
      { chatId: 'a', claimedAt: minute(1), endedAt: minute(5), endedBy: 'released' },
    ]);
  });

  it('keeps a claim with no later release open', () => {
    at('a', 'claims', 1);
    expect(pair()).toEqual([{ chatId: 'a', claimedAt: minute(1), endedAt: null, endedBy: null }]);
  });

  it('closes a span at a second claim’s start, ended by unknown', () => {
    at('a', 'claims', 1);
    at('a', 'claims', 3);
    at('a', 'released', 9, 'lapse-sweep');
    expect(pair()).toEqual([
      { chatId: 'a', claimedAt: minute(1), endedAt: minute(3), endedBy: 'unknown' },
      { chatId: 'a', claimedAt: minute(3), endedAt: minute(9), endedBy: 'lapsed' },
    ]);
  });

  it('ignores a release with no open span', () => {
    at('a', 'released', 1);
    at('a', 'claims', 2);
    at('a', 'released', 4, 'hand-over');
    at('a', 'released', 6);
    expect(pair()).toEqual([
      { chatId: 'a', claimedAt: minute(2), endedAt: minute(4), endedBy: 'handed-over' },
    ]);
  });

  it('pairs by the time of the transition, not the order the rows landed', () => {
    at('a', 'released', 8);
    at('a', 'claims', 2);
    expect(pair()).toEqual([
      { chatId: 'a', claimedAt: minute(2), endedAt: minute(8), endedBy: 'released' },
    ]);
  });

  it('leaves out a span the session-end cleanup closed', () => {
    at('a', 'claims', 1, 'session-start');
    at('a', 'released', 1, 'session-end');
    expect(pair()).toEqual([]);
  });

  it('follows a replaced chat id to the chat it is now', () => {
    at('old', 'claims', 1);
    at('new', 'released', 2);
    expect(pair(new Map([['old', 'new']]))).toEqual([
      { chatId: 'new', claimedAt: minute(1), endedAt: minute(2), endedBy: 'released' },
    ]);
  });

  it('pairs each chat on its own', () => {
    at('a', 'claims', 1);
    at('b', 'claims', 2);
    at('a', 'released', 3);
    expect(pair().map((span) => [span.chatId, span.endedBy])).toEqual([
      ['a', 'released'],
      ['b', null],
    ]);
  });
});
