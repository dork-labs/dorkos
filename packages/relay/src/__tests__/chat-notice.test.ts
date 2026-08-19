import { describe, it, expect, vi } from 'vitest';
import {
  createChatNoticeSender,
  chatNoticeText,
  CHAT_NOTICE_SENDER,
  NOTICE_DAMP_MS,
} from '../chat-notice.js';
import type { PublishResult } from '../types.js';

const CHAT = 'relay.human.telegram.tg-bot.12345';

/**
 * A sender over a store that knows exactly one bound chat.
 *
 * `resolveTarget` is the authorization step, so the default harness answers for
 * {@link CHAT} and one Slack channel and refuses everything else — which is
 * what a real machine looks like.
 */
function harness(overrides: { fail?: boolean; bound?: string[] } = {}) {
  let clock = 1_000_000;
  const bound = new Map(
    (overrides.bound ?? [CHAT, 'relay.human.slack.sl.C1']).map((s, i) => [s, `binding-${i}`])
  );
  const publish = vi.fn(async (): Promise<PublishResult> => {
    if (overrides.fail) throw new Error('bus down');
    return { messageId: 'm1', deliveredTo: 1 };
  });
  const resolveTarget = vi.fn((subject: string) => {
    const bindingId = bound.get(subject);
    return bindingId ? { bindingId } : null;
  });
  const notify = createChatNoticeSender({ publish, resolveTarget, now: () => clock });
  return { publish, resolveTarget, notify, advance: (ms: number) => (clock += ms) };
}

describe('chat notices', () => {
  it('publishes the line under a principal the binding router will not re-route', async () => {
    const { publish, notify } = harness();

    await expect(notify(CHAT, 'binding_paused')).resolves.toBe(true);

    expect(publish).toHaveBeenCalledWith(
      CHAT,
      { content: chatNoticeText('binding_paused') },
      { from: CHAT_NOTICE_SENDER }
    );
    // The prefix is the whole guard: `relay.system.*` is what the consent gate
    // treats as trusted server code and what BindingRouter skips.
    expect(CHAT_NOTICE_SENDER.startsWith('relay.system.')).toBe(true);
  });

  it('says a reason once per chat, then goes quiet', async () => {
    const { publish, notify, advance } = harness();

    expect(await notify(CHAT, 'binding_paused')).toBe(true);
    expect(await notify(CHAT, 'binding_paused')).toBe(false);
    advance(NOTICE_DAMP_MS - 1);
    expect(await notify(CHAT, 'binding_paused')).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('speaks again once the quiet window has passed', async () => {
    const { publish, notify, advance } = harness();

    await notify(CHAT, 'binding_paused');
    advance(NOTICE_DAMP_MS + 1);
    expect(await notify(CHAT, 'binding_paused')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('damps per reason, per chat, and per binding — not globally', async () => {
    const { publish, notify } = harness();

    await notify(CHAT, 'binding_paused');
    // A different reason in the same chat is a different fact.
    expect(await notify(CHAT, 'agent_missing')).toBe(true);
    // A different chat has its own person waiting in it.
    expect(await notify('relay.human.slack.sl.C1', 'binding_paused')).toBe(true);
    // Two bindings on one chat are two different answers.
    expect(await notify(CHAT, 'binding_paused', { binding: { id: 'binding-other' } })).toBe(true);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  // The reply subject a notice speaks on can come off a failed envelope's
  // `replyTo`, and on `relay_send` that field is written by the model. Without
  // this check an agent could fail its own delivery and have the machine post
  // into a chat nobody bound, under a consent-exempt principal (DOR-789).
  describe('a chat nothing is bound to', () => {
    it('is never spoken to, however the notice was triggered', async () => {
      const { publish, notify } = harness();
      expect(await notify('relay.human.telegram.tg-bot.99999', 'delivery_failed')).toBe(false);
      expect(await notify('relay.human.slack.sl.C-nobody', 'agent_busy')).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    });

    it('stays silent when the resolver cannot answer at all', async () => {
      // A relay whose host never installed the lookup must not fall open.
      const notify = createChatNoticeSender({
        publish: vi.fn(),
        resolveTarget: () => null,
      });
      expect(await notify(CHAT, 'delivery_failed')).toBe(false);
    });

    it('cannot be reached by varying the caller-supplied detail', async () => {
      const { publish, notify } = harness();
      for (const detail of ['a', 'b', 'c']) {
        expect(
          await notify('relay.human.telegram.tg-bot.99999', 'delivery_failed', { detail })
        ).toBe(false);
      }
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it('damps on the resolved binding, not on anything the caller varies', async () => {
    const { publish, notify } = harness();

    expect(await notify(CHAT, 'delivery_failed', { detail: 'session-1' })).toBe(true);
    // A caller that varies its detail (the failed agent subject, say) must not
    // buy itself another line — the key is (binding, chat, reason).
    expect(await notify(CHAT, 'delivery_failed', { detail: 'session-2' })).toBe(false);
    expect(await notify(CHAT, 'delivery_failed', { detail: 'session-3' })).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stays out of subjects with no person on them', async () => {
    const { publish, notify } = harness();

    expect(await notify('relay.agent.claude-code.s1', 'binding_paused')).toBe(false);
    expect(await notify('relay.human.console.main', 'binding_paused')).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never throws, and does not damp a notice that failed to send', async () => {
    const { publish, notify } = harness({ fail: true });

    expect(await notify(CHAT, 'binding_paused')).toBe(false);
    // A damper entry left behind by a failed publish would silence the next ten
    // minutes on the strength of a message nobody received.
    expect(await notify(CHAT, 'binding_paused')).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('writes one plain sentence a non-developer can act on', () => {
    for (const reason of [
      'binding_paused',
      'receive_denied',
      'agent_missing',
      'session_failed',
      'agent_busy',
      'agent_held',
      'rate_limited',
      'budget_exceeded',
      'channel_archived',
    ] as const) {
      const text = chatNoticeText(reason);
      expect(text.length).toBeGreaterThan(20);
      expect(text.length).toBeLessThan(240);
      // No stack traces, no subject grammar, no codes.
      expect(text).not.toMatch(/relay\.|_[a-z]+_|Error:/);
    }
  });

  it('never asks for a resend instead of waiting, and promises nothing while it waits', () => {
    const held = chatNoticeText('agent_held');
    // Seeded defect: restore the old `agent_busy` line, "The agent is handling
    // as much as it can right now… Send it again in a moment", as the answer to
    // a busy runtime. A person is then asked to do work the machine now does
    // for them, which is the whole point of the hold.
    expect(held).not.toMatch(/again/i);
    // And it must not promise an arrival it cannot guarantee: the hold's
    // ceiling is NOT the ceiling on the turn in its way, so the wait can run
    // out while the agent is still busy.
    expect(held).not.toMatch(/will be|as soon as|shortly|soon/i);
    expect(held).toMatch(/waiting its turn/);
  });

  it('asks for a resend only after the machine has tried and failed', () => {
    // `agent_busy` is now reached only when a hold ran out of time or room. By
    // then the machine has genuinely tried, and sending again is the one thing
    // that works — so naming it is help, not the refusal this work removed.
    const busy = chatNoticeText('agent_busy');
    expect(busy).toMatch(/was too busy/);
    expect(busy).toMatch(/was not picked up/);
    expect(busy).toMatch(/send it again now/i);
  });

  it('tells a chat its message is waiting, not that it was dropped', async () => {
    const { publish, notify } = harness();
    expect(await notify(CHAT, 'agent_held')).toBe(true);

    const text = chatNoticeText('agent_held');
    // The one notice here that is about work still to come, and it states only
    // the fact — the message is waiting — with no arrival attached to it.
    expect(text).toMatch(/waiting its turn/);
    expect(text).toMatch(/nothing you need to do/i);
    expect(publish).toHaveBeenCalledWith(CHAT, { content: text }, { from: CHAT_NOTICE_SENDER });

    // Damped on its own key: a chat that has been told it is waiting is not
    // told again, and being told this does not silence the `agent_busy` line
    // that a hold running out of time still owes it.
    expect(await notify(CHAT, 'agent_held')).toBe(false);
    expect(await notify(CHAT, 'agent_busy')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('tells a chat, once, that its channel was archived out from under the bridge (spec §10.9)', async () => {
    const { publish, notify } = harness();
    expect(await notify(CHAT, 'channel_archived')).toBe(true);
    // Damped like every other reason: two inbound messages racing the same
    // archive tell the person once, not twice.
    expect(await notify(CHAT, 'channel_archived')).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      CHAT,
      { content: chatNoticeText('channel_archived') },
      { from: CHAT_NOTICE_SENDER }
    );
  });
});
