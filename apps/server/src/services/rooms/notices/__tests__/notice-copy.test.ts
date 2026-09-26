/**
 * What a room says about an agent that is waiting on a person.
 *
 * The notice is durable: somebody reads it whenever they next open the room,
 * which may be an hour later. So it must not promise anything the code will have
 * stopped doing by then. It used to end "it gives up if nobody does", read off a
 * ten-minute auto-deny; an agent now holds an unanswered prompt for four hours
 * (spec `ask-parks-on-timeout` §10), which made that clause a claim the product
 * no longer keeps.
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_POINTER_NOTICE_CODES,
  SESSION_POINTER_PHRASE,
  type RoomEntryBody,
} from '@dorkos/shared/room-schemas';
import * as copy from '../notice-copy.js';
import { buildWaitingNotice, type WaitingKind } from '../notice-copy.js';

const KINDS: WaitingKind[] = ['approval', 'question', 'elicitation'];

describe('buildWaitingNotice', () => {
  it('never claims the agent gives up if nobody answers', () => {
    for (const kind of KINDS) {
      const { text } = buildWaitingNotice('Ana', 'author-ana', kind);
      expect(text).not.toContain('gives up');
      expect(text).toContain('It will wait, but not forever.');
    }
  });

  it('names the agent and where to answer, and nothing about the prompt itself', () => {
    // The notice reaches everybody in the room, so the tool name, the path and
    // the question stay in the session with the person who can act on them.
    const { text } = buildWaitingNotice('Ana', 'author-ana', 'approval');

    expect(text).toBe(
      "Ana is waiting for you to approve something before it can carry on. Open Ana's session to answer. It will wait, but not forever."
    );
  });

  it('carries no countdown, because a durable line cannot hold one honestly', () => {
    for (const kind of KINDS) {
      const { text } = buildWaitingNotice('Ana', 'author-ana', kind);
      expect(text).not.toMatch(/\d+\s*(minutes?|hours?)/);
    }
  });
});

/** Every notice builder this module exports, by name. */
type NoticeBuilder = Extract<keyof typeof copy, `build${string}Notice`>;

/**
 * Every notice this module can write, in every variant that changes its words.
 *
 * Keyed by builder, so a new `build…Notice` export is a type error here until it
 * is added — and the first test below checks the same thing at run time.
 */
const NOTICES: Record<NoticeBuilder, () => RoomEntryBody[]> = {
  buildCascadeNotice: () => [copy.buildCascadeNotice('Ana', 'author-ana')],
  buildBudgetNotice: () => [copy.buildBudgetNotice('room'), copy.buildBudgetNotice('global')],
  buildBusyNotice: () => [
    copy.buildBusyNotice('Ana', 'author-ana', 'held-too-long'),
    copy.buildBusyNotice('Ana', 'author-ana', 'unknown'),
  ],
  buildWaitingNotice: () => KINDS.map((kind) => copy.buildWaitingNotice('Ana', 'author-ana', kind)),
  buildHaltedNotice: () => [copy.buildHaltedNotice(2)],
  buildAgentHaltedNotice: () =>
    (['interrupted', 'unstarted', 'idle'] as const).map((outcome) =>
      copy.buildAgentHaltedNotice('Kai', 'Ana', 'author-ana', outcome)
    ),
  buildTurnFailedNotice: () => [copy.buildTurnFailedNotice('Ana', 'author-ana')],
  buildAgentGoneNotice: () => [copy.buildAgentGoneNotice('Ana', 'author-ana')],
  buildRuntimeGoneNotice: () => [
    copy.buildRuntimeGoneNotice('Ana', 'author-ana', 'codex'),
    copy.buildRuntimeGoneNotice('Ana', 'author-ana', undefined),
  ],
  buildAgentUnavailableNotice: () => [copy.buildAgentUnavailableNotice('Ana', 'author-ana')],
  buildAgentLeftNotice: () => [copy.buildAgentLeftNotice('Ana', 'author-ana')],
  buildAgentDeclinedNotice: () => [copy.buildAgentDeclinedNotice('Ana', 'author-ana')],
  buildBridgeSecondAgentRefusedNotice: () => [copy.buildBridgeSecondAgentRefusedNotice('Ana')],
  buildBridgeRateLimitedNotice: () => [copy.buildBridgeRateLimitedNotice()],
  buildBridgeDisconnectedNotice: () => [
    copy.buildBridgeDisconnectedNotice('token revoked'),
    copy.buildBridgeDisconnectedNotice(),
  ],
  buildBridgeAgentSwappedNotice: () => [copy.buildBridgeAgentSwappedNotice('Ana', 'Bo')],
  buildBridgeHistoryNotice: () => [
    copy.buildBridgeHistoryNotice(true),
    copy.buildBridgeHistoryNotice(false),
  ],
  buildBridgeBlockedNotice: () =>
    (['reply_off', 'initiate_off', 'lost_provenance'] as const).map((reason) =>
      copy.buildBridgeBlockedNotice(reason)
    ),
  buildBridgeUndeliveredNotice: () => [copy.buildBridgeUndeliveredNotice('hello')],
  buildRoomArchivedNotice: () => [copy.buildRoomArchivedNotice('Ana', 'author-ana')],
};

function everyNotice(): RoomEntryBody[] {
  return Object.values(NOTICES).flatMap((build) => build());
}

/** Words that send the reader to a session: "Open Ana's session …". */
const SENDS_TO_SESSION = /\bopen\b[^.]*\bsession\b/i;

describe('notices that send the reader to a session (DOR-2077)', () => {
  it('builds every notice the module exports, so none can slip past the checks below', () => {
    const exported = Object.keys(copy).filter((name) => /^build\w*Notice$/.test(name));
    expect(Object.keys(NOTICES).sort()).toEqual(exported.sort());
  });

  it('lists every notice that says to open a session, so the app can link it', () => {
    // A line that says "Open Ana's session" with no way there is the bug
    // DOR-2077 was filed for. The client draws the link for the codes in
    // SESSION_POINTER_NOTICE_CODES, so a new line that sends people to a session
    // has to join that list.
    for (const notice of everyNotice()) {
      if (!SENDS_TO_SESSION.test(notice.text)) continue;
      expect(SESSION_POINTER_NOTICE_CODES, notice.text).toContain(notice.notice);
      // The link is resolved from who the notice is about, and drawn over
      // exactly these words — so they have to be there, spelled this way.
      expect(notice.subjectAuthorId, notice.text).toBeDefined();
      expect(notice.text).toMatch(SESSION_POINTER_PHRASE);
    }
  });

  it('lists no code whose notices never send anybody to a session', () => {
    const pointing = new Set(
      everyNotice()
        .filter((notice) => SENDS_TO_SESSION.test(notice.text))
        .map((notice) => notice.notice)
    );
    for (const code of SESSION_POINTER_NOTICE_CODES) expect(pointing).toContain(code);
  });

  it('recognises the words it is looking for, and not a mention of a session', () => {
    // Purpose: prove the matcher can fail, so an empty violation list means something.
    expect(SENDS_TO_SESSION.test("Open Ana's session to answer.")).toBe(true);
    expect(SENDS_TO_SESSION.test('Ana was busy in its own session.')).toBe(false);
  });
});
