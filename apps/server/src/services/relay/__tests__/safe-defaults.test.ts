import { describe, it, expect } from 'vitest';
import {
  carryForwardBindingDefaults,
  carryForwardAdapterDefaults,
  closeDmPolicyOnEnable,
} from '../safe-defaults.js';
import {
  AdapterBindingSchema,
  SlackAdapterConfigSchema,
  TelegramAdapterConfigSchema,
} from '@dorkos/shared/relay-schemas';

/** A stored binding as `bindings.json` holds it, minus the keys under test. */
function storedBinding(extra: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    adapterId: 'slack',
    agentId: 'dorkbot',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const SLACK = { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'sec' };
const TELEGRAM = { token: '123:ABC', mode: 'polling' };

/** Carry one stored adapter entry forward and return its config. */
function carriedConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const carried = carryForwardAdapterDefaults({
    adapters: [{ id: type, type, enabled: true, config }],
  }) as { adapters: { config: Record<string, unknown> }[] };
  return carried.adapters[0].config;
}

describe('new configuration starts safe (DOR-604, DOR-788)', () => {
  it('a new binding prompts, and new Slack and Telegram connections answer DMs by allowlist', () => {
    expect(AdapterBindingSchema.parse(storedBinding()).permissionMode).toBe('default');
    expect(SlackAdapterConfigSchema.parse(SLACK)).toMatchObject({
      dmPolicy: 'allowlist',
      dmAllowlist: [],
    });
    expect(TelegramAdapterConfigSchema.parse({ token: '123:ABC' })).toMatchObject({
      dmPolicy: 'allowlist',
      dmAllowlist: [],
    });
  });
});

describe('carryForwardBindingDefaults', () => {
  it('stamps acceptEdits onto a binding stored without a mode, surviving the schema parse', () => {
    const carried = carryForwardBindingDefaults({ bindings: [storedBinding()] }) as {
      bindings: unknown[];
    };
    expect(AdapterBindingSchema.parse(carried.bindings[0]).permissionMode).toBe('acceptEdits');
  });

  it.each(['bypassPermissions', 'default'])('leaves a binding stored as %s alone', (mode) => {
    const carried = carryForwardBindingDefaults({
      bindings: [storedBinding({ permissionMode: mode })],
    }) as { bindings: Record<string, unknown>[] };
    expect(carried.bindings[0].permissionMode).toBe(mode);
  });
});

describe('carryForwardAdapterDefaults', () => {
  // A stored entry with no dmPolicy was written by an older build that answered
  // every DM, so it stays open rather than going silent on upgrade.
  it.each([
    ['slack', SLACK, SlackAdapterConfigSchema],
    ['telegram', TELEGRAM, TelegramAdapterConfigSchema],
  ] as const)(
    'keeps a stored %s connection open through the schema parse',
    (type, config, schema) => {
      expect(schema.parse(carriedConfig(type, config)).dmPolicy).toBe('open');
    }
  );

  it('leaves a connection that chose allowlist alone, and ignores types with no DM policy', () => {
    expect(
      carriedConfig('telegram', { ...TELEGRAM, dmPolicy: 'allowlist', dmAllowlist: ['42'] })
        .dmPolicy
    ).toBe('allowlist');
    expect(
      carriedConfig('webhook', { inbound: { subject: 's', secret: 'x'.repeat(16) } })
    ).not.toHaveProperty('dmPolicy');
  });

  it('closes an unreadable stored value rather than letting it through', () => {
    expect(carriedConfig('telegram', { ...TELEGRAM, dmPolicy: '' }).dmPolicy).toBe('allowlist');
  });

  it('does not carry a stored Telegram integration forward to always (DOR-619)', () => {
    // Nobody chose "answer every message in every group"; that was the defect.
    const config = carriedConfig('telegram', { ...TELEGRAM, streaming: true });
    expect(config).not.toHaveProperty('respondMode');
    expect(TelegramAdapterConfigSchema.parse(config).respondMode).toBe('thread-aware');
  });
});

describe('closeDmPolicyOnEnable', () => {
  it.each([
    [
      'an open Slack connection',
      'slack',
      { dmPolicy: 'open', dmAllowlist: ['U1'] },
      true,
      'allowlist',
    ],
    [
      'a Telegram connection with no stored policy',
      'telegram',
      { dmAllowlist: ['42'] },
      true,
      'allowlist',
    ],
    [
      'an allowlisted connection',
      'telegram',
      { dmPolicy: 'allowlist', dmAllowlist: ['42'] },
      false,
      'allowlist',
    ],
    ['a webhook', 'webhook', { dmPolicy: 'open' }, false, 'open'],
  ])('handles %s', (_label, type, config, changed, policy) => {
    const entry = { type, config: { ...config } as Record<string, unknown> };
    expect(closeDmPolicyOnEnable(entry)).toBe(changed);
    expect(entry.config.dmPolicy).toBe(policy);
    if ('dmAllowlist' in config) expect(entry.config.dmAllowlist).toEqual(config.dmAllowlist);
  });
});
