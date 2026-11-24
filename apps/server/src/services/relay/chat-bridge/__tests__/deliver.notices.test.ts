/**
 * `ChatBridgeDelivery` and room notices (chats-as-channels §6.2): which notice
 * codes reach a bridged chat, the per-bridge `deliverNotices` switch, the busy
 * damper (DOR-1359), and the far-end waiting sentence (spec `ask-entitlement`
 * §5.4). Shared setup and the mocking stance live in `deliver.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBusyNotice,
  buildWaitingNotice,
  type WaitingKind,
} from '../../../rooms/notices/notice-copy.js';
import {
  AGENT_PATH,
  bindingRow,
  makeBinding,
  useDeliveryFixture,
  type StandingCards,
} from './deliver.fixtures.js';

const STOPPED_TEXT = {
  turn_failed: 'A turn failed.',
  halted: 'Everything here was stopped. Nothing was running at the time.',
} as const;

describe('ChatBridgeDelivery notices (chats-as-channels §6.2)', () => {
  const t = useDeliveryFixture();
  const { bridgeRequest, makeDelivery, noticesOf, seedInbound, agentPost } = t;

  /** A bridged DM (or channel) with a permissive binding, ready to deliver. */
  function bridged(chatId: string, opts: { group?: boolean; deliverNotices?: boolean } = {}) {
    const room = t.harness.service.createBridgedRoom({
      ...bridgeRequest(chatId, opts.group),
      bindingId: `binding-${chatId}`,
    });
    if (opts.deliverNotices !== undefined) {
      t.harness.bridges.setDeliverNotices(room.id, opts.deliverNotices);
    }
    t.binding = makeBinding({ canReply: true, canInitiate: true });
    return { room, delivery: makeDelivery(bindingRow(room.id, chatId)) };
  }

  /** The content of publish call `i`. */
  function sentText(i = 0): string {
    return (t.publish.mock.calls[i]![1] as Record<string, unknown>).content as string;
  }

  describe('the deliverNotices switch', () => {
    it('A6.6: a halted notice reaches a bridged DM by default and NOT a bridged channel', async () => {
      const code = 'halted';
      const dm = bridged('555');
      const dmNotice = t.harness.service.postNotice(dm.room.id, {
        text: STOPPED_TEXT[code],
        notice: code,
      });
      expect(await dm.delivery.deliverEntry(dmNotice)).toBe('delivered');

      const ch = bridged('777', { group: true });
      const chNotice = t.harness.service.postNotice(ch.room.id, {
        text: STOPPED_TEXT[code],
        notice: code,
      });
      expect(await ch.delivery.deliverEntry(chNotice)).toBe('skipped');
    });

    it.each([
      ['ON for a channel', true, true, 'delivered'],
      ['OFF for a dm', false, false, 'skipped'],
    ] as const)(
      'the one per-bridge override turns delivery %s: turn_failed and halted both follow it',
      async (_label, group, deliverNotices, expected) => {
        const { room, delivery } = bridged('779', { group, deliverNotices });
        for (const code of ['turn_failed', 'halted'] as const) {
          const notice = t.harness.service.postNotice(room.id, {
            text: STOPPED_TEXT[code],
            notice: code,
          });
          expect(await delivery.deliverEntry(notice)).toBe(expected);
        }
      }
    );
  });

  // A bridged DM delivers notices by default (§6.2), so each case isolates the
  // NOTICE-CODE eligibility from the deliverNotices gate itself.
  it.each([
    [
      'cascade_stopped',
      'Ana stopped replying here. This back-and-forth hit its automatic-reply limit.',
    ],
    // It is about DorkOS, not about the chat.
    [
      'bridge_rate_limited',
      'Messages are arriving from the chat faster than this channel can record them.',
    ],
  ] as const)('%s is never delivered, even to a DM that delivers notices', async (code, text) => {
    const { room, delivery } = bridged('601');
    const notice = t.harness.service.postNotice(room.id, { text, notice: code });
    expect(await delivery.deliverEntry(notice)).toBe('skipped');
  });

  describe('DOR-1359: a stopped agent is reported to the chat — awaiting_approval and agent_busy', () => {
    /**
     * A bridged DM with an inbound message to root the notice at, so it
     * classifies as a REPLY the way a real waiting/busy notice does: both are
     * written by `RoomNoticeLog` stamped with the triggering entry's cascade,
     * and in a bridged room that entry is the message that arrived from the
     * chat.
     */
    function bridgedDm(chatId: string) {
      const { room: dm, delivery } = bridged(chatId);
      const inbound = seedInbound(dm.id, chatId, 'can you do the thing?', `pm-${chatId}`);
      const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      /** Post a notice rooted at the inbound message. */
      const post = (body: Parameters<typeof t.harness.service.postNotice>[1]) =>
        t.harness.service.postNotice(dm.id, body, { root: inbound.id, depth: 1 });
      return { dm, delivery, inbound, ana, post };
    }

    it('busy refusals buzz the chat ONCE, word for word, until the agent next answers there', async () => {
      // `RoomNoticeLog.reportSilence` does NOT damp a message that directly
      // asked the agent, and in a `dm` every human message counts as asking, so
      // without a damper of its own the bridge would buzz once per message.
      const { dm, delivery, inbound, ana, post } = bridgedDm('619');
      const busy = () => post(buildBusyNotice('Ana', ana.id, 'held-too-long'));
      const outcomes = [];
      for (let i = 0; i < 3; i += 1) outcomes.push(await delivery.deliverEntry(busy()));

      // Three DISTINCT entries in the room log — not idempotence on one entry.
      expect(noticesOf(dm.id, 'agent_busy')).toHaveLength(3);
      expect(outcomes).toEqual(['delivered', 'damped', 'damped']);
      // It never names the other conversation.
      expect(sentText()).toBe(buildBusyNotice('Ana', ana.id, 'held-too-long').text);

      // Ana answers here — the same re-arm `RoomNoticeLog.recovered` uses.
      expect(await delivery.deliverEntry(agentPost(dm.id, 'back now', inbound.id))).toBe(
        'delivered'
      );
      expect(await delivery.deliverEntry(busy())).toBe('delivered');
      expect(t.publish).toHaveBeenCalledTimes(3);
    });
  });

  it('turn_failed is re-rendered for the chat, not forwarded verbatim: the delivered text names no session', async () => {
    const { room, delivery } = bridged('558');
    const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    const notice = t.harness.service.postNotice(room.id, {
      text: "Ana ran into a problem and could not answer here. Open Ana's chat to see what went wrong.",
      notice: 'turn_failed',
      subjectAuthorId: ana.id,
    });
    expect(await delivery.deliverEntry(notice)).toBe('delivered');
    expect(sentText()).toBe(
      "Ana ran into a problem and couldn't answer. Try sending your message again."
    );
    expect(sentText()).not.toContain('session');
  });

  describe('awaiting_approval — the far-end waiting sentence (spec `ask-entitlement` §5.4)', () => {
    /** A distinctive tool name, so a leak of the prompt's detail is unmistakable. */
    const SECRET_TOOL = 'ZzTopSecretTool';
    const APPROVAL_SENTENCE =
      'Ana is waiting for someone to approve something before it can carry on. Answer it in DorkOS. It gives up if nobody does.';

    /**
     * Post a waiting notice the way `buildWaitingNotice` writes one, and
     * deliver it. The body comes from the REAL copy function rather than a
     * hand-written literal: the assertion is that the far-end text DIFFERS
     * from the room's own, and a literal would let both drift together.
     */
    async function deliverWaiting(chatId: string, kind: WaitingKind, asks?: StandingCards) {
      const dm = t.harness.service.createBridgedRoom(bridgeRequest(chatId));
      const delivery = makeDelivery(bindingRow(dm.id, chatId), asks);
      t.binding = makeBinding({ canReply: true, canInitiate: true });
      const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const notice = t.harness.service.postNotice(dm.id, buildWaitingNotice('Ana', ana.id, kind));
      const outcome = await delivery.deliverEntry(notice);
      return { dm, ana, outcome };
    }

    // An agent that stops for a person and says nothing to the chat it stopped
    // in is indistinguishable from one that crashed. Each kind gets its own
    // sentence, none pointing at a session the reader has no access to.
    it.each([
      ['approval', APPROVAL_SENTENCE],
      [
        'question',
        'Ana has a question that needs answering before it can carry on. Answer it in DorkOS. It gives up if nobody does.',
      ],
    ] as const)(
      'the %s wait reaches a bridged DM in its own far-end sentence',
      async (kind, text) => {
        const { outcome } = await deliverWaiting('620', kind);

        expect(outcome).toBe('delivered');
        expect(sentText()).toBe(text);
        expect(sentText()).not.toContain("Ana's session");
      }
    );

    it('falls back to the approval sentence for an entry stored before the kind was recorded', async () => {
      // Every `awaiting_approval` entry written before `waitingKind` existed is
      // still in somebody's room log, and the catch-up scan will hand one here.
      const { room, delivery } = bridged('623');
      const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const notice = t.harness.service.postNotice(room.id, {
        text: "Ana has a question for you before it can carry on. Open Ana's session to answer.",
        notice: 'awaiting_approval',
        subjectAuthorId: ana.id,
      });

      expect(await delivery.deliverEntry(notice)).toBe('delivered');
      expect(sentText()).toBe(APPROVAL_SENTENCE);
    });

    it('carries none of the prompt’s detail — no tool name, no input, no path (DOR-613)', async () => {
      // The room's own line already keeps this rule (DOR-613); the far end is
      // further away, not closer.
      const { room, delivery } = bridged('624');
      const ana = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const notice = t.harness.service.postNotice(room.id, {
        ...buildWaitingNotice('Ana', ana.id, 'approval'),
        // A body that DOES carry the detail, so the assertion is about what
        // the renderer chooses rather than about what the fixture omitted.
        text: `Ana wants to run ${SECRET_TOOL} against /work/alpha/secrets.env`,
      });

      expect(await delivery.deliverEntry(notice)).toBe('delivered');
      expect(sentText()).not.toContain(SECRET_TOOL);
      expect(sentText()).not.toContain('/work/alpha/secrets.env');
    });

    it('is suppressed while a card is standing for that agent, and the room entry is still written', async () => {
      // Without this, an approver sees the card immediately and a
      // near-duplicate line a minute later.
      const { dm, outcome } = await deliverWaiting('625', 'approval', {
        hasStandingCard: () => true,
      });

      expect(outcome).toBe('skipped');
      expect(t.publish).not.toHaveBeenCalled();
      expect(
        noticesOf(dm.id, 'awaiting_approval'),
        'the room log is untouched — only the DELIVERY is suppressed'
      ).toHaveLength(1);
    });
  });
});
