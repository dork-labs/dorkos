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
import { SESSION_POINTER_NOTICE_CODES } from '@dorkos/shared/room-schemas';
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import {
  buildAgentDeclinedNotice,
  buildAgentGoneNotice,
  buildAgentHaltedNotice,
  buildAgentLeftNotice,
  buildAgentUnavailableNotice,
  buildBridgeAgentSwappedNotice,
  buildBridgeBlockedNotice,
  buildBridgeDisconnectedNotice,
  buildBridgeHistoryNotice,
  buildBridgeRateLimitedNotice,
  buildBridgeSecondAgentRefusedNotice,
  buildBridgeUndeliveredNotice,
  buildBudgetNotice,
  buildBusyNotice,
  buildCascadeNotice,
  buildHaltedNotice,
  buildRoomArchivedNotice,
  buildRuntimeGoneNotice,
  buildTurnFailedNotice,
  buildWaitingNotice,
  type WaitingKind,
} from '../notice-copy.js';

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

/**
 * Every notice this module can write, in every variant that changes its words.
 * A new builder belongs here too — the check below is only as good as this list.
 */
function everyNotice(): RoomEntryBody[] {
  return [
    buildCascadeNotice('Ana', 'author-ana'),
    buildBudgetNotice('room'),
    buildBudgetNotice('global'),
    buildBusyNotice('Ana', 'author-ana', 'held-too-long'),
    buildBusyNotice('Ana', 'author-ana', 'unknown'),
    ...KINDS.map((kind) => buildWaitingNotice('Ana', 'author-ana', kind)),
    buildHaltedNotice(2),
    buildAgentHaltedNotice('Kai', 'Ana', 'author-ana', 'interrupted'),
    buildAgentHaltedNotice('Kai', 'Ana', 'author-ana', 'unstarted'),
    buildAgentHaltedNotice('Kai', 'Ana', 'author-ana', 'idle'),
    buildTurnFailedNotice('Ana', 'author-ana'),
    buildAgentGoneNotice('Ana', 'author-ana'),
    buildRuntimeGoneNotice('Ana', 'author-ana', 'codex'),
    buildAgentUnavailableNotice('Ana', 'author-ana'),
    buildAgentLeftNotice('Ana', 'author-ana'),
    buildAgentDeclinedNotice('Ana', 'author-ana'),
    buildBridgeSecondAgentRefusedNotice('Ana'),
    buildBridgeRateLimitedNotice(),
    buildBridgeDisconnectedNotice('token revoked'),
    buildBridgeAgentSwappedNotice('Ana', 'Bo'),
    buildBridgeHistoryNotice(true),
    buildBridgeHistoryNotice(false),
    buildBridgeBlockedNotice('reply_off'),
    buildBridgeBlockedNotice('initiate_off'),
    buildBridgeBlockedNotice('lost_provenance'),
    buildBridgeUndeliveredNotice('hello'),
    buildRoomArchivedNotice('Ana', 'author-ana'),
  ];
}

/** Words that send the reader to a session: "Open Ana's session …". */
const SENDS_TO_SESSION = /\bopen\b[^.]*\bsession\b/i;

describe('notices that send the reader to a session (DOR-2077)', () => {
  it('lists every notice that says to open a session, so the app can link it', () => {
    // A line that says "Open Ana's session" with no way there is the bug
    // DOR-2077 was filed for. The client draws the link for the codes in
    // SESSION_POINTER_NOTICE_CODES, so a new line that sends people to a session
    // has to join that list.
    for (const notice of everyNotice()) {
      if (!SENDS_TO_SESSION.test(notice.text)) continue;
      expect(SESSION_POINTER_NOTICE_CODES, notice.text).toContain(notice.notice);
      // The link is resolved from who the notice is about.
      expect(notice.subjectAuthorId, notice.text).toBeDefined();
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
