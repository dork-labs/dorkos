/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: a new Telegram or Slack connection answers nobody until a
 * person names who may talk to it, and nobody in an outside chat may approve
 * a tool call until a person names who may.
 *
 * - `dmPolicy` defaults to `'allowlist'` with an EMPTY list. A bot handle is
 *   public; opening it lets any stranger drive an agent on this machine
 *   (DOR-604, DOR-788).
 * - `approverAllowlist` defaults to empty, and empty means nobody. Talking to
 *   an agent and approving a shell command are different privileges (DOR-609).
 *
 * These are not the agent-trust dials the reset opens: they govern people
 * OUTSIDE the operator's circle. The gate behaviour itself is covered in
 * `slack/__tests__/inbound.test.ts`, `telegram/__tests__/inbound.test.ts`
 * (including "defaults to the allowlist when the config never reached the
 * schema") and `approver-allowlist.test.ts`; this file pins the DEFAULTS a
 * fresh connection is born with, end to end through the gate that reads them.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  SlackAdapterConfigSchema,
  TelegramAdapterConfigSchema,
} from '@dorkos/shared/relay-schemas';
import { mayApprove } from '../approver-allowlist.js';
import { createSlackInboundState, handleInboundMessage } from '../slack/inbound.js';
import { createMockRelay } from '../../__tests__/fixtures.js';

/** A fresh connection, as the setup form creates one: credentials and nothing else. */
const FRESH = {
  telegram: TelegramAdapterConfigSchema.parse({ token: 'tg-token' }),
  slack: SlackAdapterConfigSchema.parse({
    botToken: 'xoxb-1',
    appToken: 'xapp-1',
    signingSecret: 'secret',
  }),
};

/** Somebody nobody named. */
const STRANGER = 'U0STRANGER';

describe.each(Object.entries(FRESH))('a fresh %s connection', (_name, config) => {
  it('lets nobody message it privately until a person names them', () => {
    expect(config.dmPolicy).toBe('allowlist');
    expect(config.dmAllowlist).toEqual([]);
  });

  it('lets nobody in the chat approve a tool call', () => {
    expect(config.approverAllowlist).toEqual([]);
    expect(mayApprove(config.approverAllowlist, STRANGER)).toBe(false);
  });
});

describe('a stranger’s direct message to a fresh Slack connection', () => {
  it('runs no turn', async () => {
    const relay = createMockRelay();
    const client = {
      users: { info: vi.fn().mockResolvedValue({ user: { name: 'stranger' } }) },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'dm' } }) },
      reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
    } as unknown as WebClient;

    await handleInboundMessage(
      { type: 'message', user: STRANGER, text: 'run the deploy', channel: 'D1', ts: '1.1' },
      client,
      relay,
      'UBOT',
      { trackInbound: vi.fn(), recordError: vi.fn() },
      createSlackInboundState(),
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      'none',
      undefined,
      undefined,
      // Exactly what `SlackAdapter` hands the gate from its stored config.
      { dmPolicy: FRESH.slack.dmPolicy, dmAllowlist: FRESH.slack.dmAllowlist }
    );

    expect(relay.publish).not.toHaveBeenCalled();
  });
});
