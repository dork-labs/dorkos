import { describe, it, expect, vi } from 'vitest';
import {
  createChatNoticeSender,
  chatNoticeText,
  CHAT_NOTICE_SENDER,
  NOTICE_DAMP_MS,
} from '../chat-notice.js';
import type { PublishResult } from '../types.js';

const CHAT = 'relay.human.telegram.tg-bot.12345';

function harness(overrides: { fail?: boolean } = {}) {
  let clock = 1_000_000;
  const publish = vi.fn(async (): Promise<PublishResult> => {
    if (overrides.fail) throw new Error('bus down');
    return { messageId: 'm1', deliveredTo: 1 };
  });
  const notify = createChatNoticeSender({ publish, now: () => clock });
  return { publish, notify, advance: (ms: number) => (clock += ms) };
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

    await notify(CHAT, 'binding_paused', { scope: 'binding-1' });
    // A different reason in the same chat is a different fact.
    expect(await notify(CHAT, 'agent_missing', { scope: 'binding-1' })).toBe(true);
    // A different chat has its own person waiting in it.
    expect(await notify('relay.human.slack.sl.C1', 'binding_paused', { scope: 'binding-1' })).toBe(
      true
    );
    // Two bindings on one chat are two different answers.
    expect(await notify(CHAT, 'binding_paused', { scope: 'binding-2' })).toBe(true);
    expect(publish).toHaveBeenCalledTimes(4);
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
      'rate_limited',
      'budget_exceeded',
    ] as const) {
      const text = chatNoticeText(reason);
      expect(text.length).toBeGreaterThan(20);
      expect(text.length).toBeLessThan(240);
      // No stack traces, no subject grammar, no codes.
      expect(text).not.toMatch(/relay\.|_[a-z]+_|Error:/);
    }
  });
});
