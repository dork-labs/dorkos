/**
 * How a ticket's `claims` and `released` edges pair into spans (DOR-4972), rule
 * by rule as `../work-item-chats.ts` writes them down, over the real edge store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { WorkLinkStore, type ClaimLinkSource } from '../../work-link-store.js';
import { pairClaimSpans, type ChatSpan } from '../work-item-chats.js';

const TICKET = { kind: 'ticket', id: 'DOR-7' } as const;
let store: WorkLinkStore;

/** Record one transition of `chat` at minute `minute`. */
function at(
  chat: string,
  relation: 'claims' | 'released',
  minute: number,
  source: ClaimLinkSource = relation === 'claims' ? 'claim-tool' : 'release-tool',
  recordingChatId: string | null = null
): void {
  const result = store.record({
    from: { kind: 'chat', id: chat },
    relation,
    to: TICKET,
    source,
    recordingChatId,
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

/** A span from minute `from` to minute `to` (open when null), as the pairing returns it. */
function span(
  chatId: string,
  from: number,
  to: number | null,
  endedBy: ChatSpan['endedBy'],
  extra: Partial<ChatSpan> = {}
): ChatSpan {
  return {
    chatId,
    claimedAt: minute(from),
    endedAt: to === null ? null : minute(to),
    endedBy,
    handedTo: null,
    ...extra,
  };
}

beforeEach(() => {
  store = new WorkLinkStore({ db: createTestDb() });
});

describe('pairing claims into spans', () => {
  it('opens a span on a claim and closes it on the next release', () => {
    at('a', 'claims', 1);
    at('a', 'released', 5);
    expect(pair()).toEqual([span('a', 1, 5, 'released')]);
  });

  it('keeps a claim with no later release open', () => {
    at('a', 'claims', 1);
    expect(pair()).toEqual([span('a', 1, null, null)]);
  });

  it('closes a span at a second claim’s start, ended by unknown', () => {
    at('a', 'claims', 1);
    at('a', 'claims', 3);
    at('a', 'released', 9, 'lapse-sweep');
    expect(pair()).toEqual([span('a', 1, 3, 'unknown'), span('a', 3, 9, 'lapsed')]);
  });

  it('opens a span for the chat `session_start` claimed for, whatever chat called it', () => {
    at('new-lane', 'claims', 1, 'session-start', 'caller');
    expect(pair()).toEqual([span('new-lane', 1, null, null)]);
  });

  it('names the taker of a hand-over, by the id it has now, for the read to judge', () => {
    at('a', 'claims', 1);
    at('a', 'released', 4, 'hand-over', 'b-old');
    at('b-old', 'claims', 4, 'hand-over', 'b-old');
    expect(pair(new Map([['b-old', 'b']]))).toEqual([
      span('a', 1, 4, 'handed-over', { handedTo: 'b' }),
      span('b', 4, null, null),
    ]);
  });

  it('ignores a claims row no claim writer wrote', () => {
    at('a', 'claims', 1, 'lapse-sweep');
    expect(pair()).toEqual([]);
  });

  it('orders one chat’s rows at the same time by their id, the order they landed', () => {
    // The release lands first, then the claim, at one time: the release is a stray (no span
    // was open) and the claim opens a span that stays open. Without the id order the claim
    // would come first (the read lists claims, then releases) and the release would close it.
    at('a', 'released', 1);
    at('a', 'claims', 1);
    expect(pair()).toEqual([span('a', 1, null, null)]);
  });

  it('ignores a release with no open span', () => {
    at('a', 'released', 1);
    at('a', 'claims', 2);
    at('a', 'released', 4, 'hand-over');
    at('a', 'released', 6);
    expect(pair()).toEqual([span('a', 2, 4, 'handed-over')]);
  });

  it('pairs by the time of the transition, not the order the rows landed', () => {
    at('a', 'released', 8);
    at('a', 'claims', 2);
    expect(pair()).toEqual([span('a', 2, 8, 'released')]);
  });

  it('leaves out a span the session-end cleanup closed', () => {
    at('a', 'claims', 1, 'session-start');
    at('a', 'released', 1, 'session-end');
    expect(pair()).toEqual([]);
  });

  it('follows a replaced chat id to the chat it is now', () => {
    at('old', 'claims', 1);
    at('new', 'released', 2);
    expect(pair(new Map([['old', 'new']]))).toEqual([span('new', 1, 2, 'released')]);
  });

  it('pairs each chat on its own', () => {
    at('a', 'claims', 1);
    at('b', 'claims', 2);
    at('a', 'released', 3);
    expect(pair().map((s) => [s.chatId, s.endedBy])).toEqual([
      ['a', 'released'],
      ['b', null],
    ]);
  });
});
