import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  carryForwardBindingDefaults,
  carryForwardAdapterDefaults,
  warnOnOpenDmPolicy,
} from '../safe-defaults.js';
import { AdapterBindingSchema, SlackAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import { logger } from '../../../lib/logger.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The new defaults themselves
// ---------------------------------------------------------------------------

describe('the safe default applies to newly created configuration (DOR-604)', () => {
  it('a new binding runs in the prompting mode, not acceptEdits', () => {
    const binding = AdapterBindingSchema.parse(storedBinding());
    expect(binding.permissionMode).toBe('default');
  });

  it('a new Slack integration answers DMs by allowlist, not the whole workspace', () => {
    const config = SlackAdapterConfigSchema.parse({
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 'sec',
    });
    expect(config.dmPolicy).toBe('allowlist');
    expect(config.dmAllowlist).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Carry-forward: an existing install keeps working
// ---------------------------------------------------------------------------

describe('carryForwardBindingDefaults', () => {
  it('stamps acceptEdits onto a binding stored without the key', () => {
    const carried = carryForwardBindingDefaults({ bindings: [storedBinding()] }) as {
      bindings: Record<string, unknown>[];
    };
    expect(carried.bindings[0].permissionMode).toBe('acceptEdits');
  });

  it('survives the schema parse it runs ahead of, landing on acceptEdits not default', () => {
    const carried = carryForwardBindingDefaults({ bindings: [storedBinding()] }) as {
      bindings: unknown[];
    };
    expect(AdapterBindingSchema.parse(carried.bindings[0]).permissionMode).toBe('acceptEdits');
  });

  it('leaves a binding that already named its mode alone', () => {
    const carried = carryForwardBindingDefaults({
      bindings: [storedBinding({ permissionMode: 'bypassPermissions' })],
    }) as { bindings: Record<string, unknown>[] };
    expect(carried.bindings[0].permissionMode).toBe('bypassPermissions');
  });

  it('does not resurrect a mode the operator explicitly set to the prompting one', () => {
    const carried = carryForwardBindingDefaults({
      bindings: [storedBinding({ permissionMode: 'default' })],
    }) as { bindings: Record<string, unknown>[] };
    expect(carried.bindings[0].permissionMode).toBe('default');
  });

  it('passes malformed input through for the schema to reject', () => {
    expect(carryForwardBindingDefaults(null)).toBeNull();
    expect(carryForwardBindingDefaults({ bindings: 'nope' })).toEqual({ bindings: 'nope' });
  });
});

describe('carryForwardAdapterDefaults', () => {
  const slackEntry = (config: Record<string, unknown>) => ({
    id: 'slack',
    type: 'slack',
    enabled: true,
    config,
  });
  const secrets = { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'sec' };

  it('stamps open onto a Slack integration stored without dmPolicy', () => {
    const carried = carryForwardAdapterDefaults({ adapters: [slackEntry(secrets)] }) as {
      adapters: { config: Record<string, unknown> }[];
    };
    expect(carried.adapters[0].config.dmPolicy).toBe('open');
  });

  it('survives the schema parse it runs ahead of, landing on open not allowlist', () => {
    const carried = carryForwardAdapterDefaults({ adapters: [slackEntry(secrets)] }) as {
      adapters: { config: unknown }[];
    };
    expect(SlackAdapterConfigSchema.parse(carried.adapters[0].config).dmPolicy).toBe('open');
  });

  it('leaves a Slack integration that already chose allowlist alone', () => {
    const carried = carryForwardAdapterDefaults({
      adapters: [slackEntry({ ...secrets, dmPolicy: 'allowlist', dmAllowlist: ['U1'] })],
    }) as { adapters: { config: Record<string, unknown> }[] };
    expect(carried.adapters[0].config.dmPolicy).toBe('allowlist');
  });

  it('ignores adapters of other types', () => {
    const telegram = { id: 'tg', type: 'telegram', enabled: true, config: { botToken: 't' } };
    const carried = carryForwardAdapterDefaults({ adapters: [telegram] }) as {
      adapters: { config: Record<string, unknown> }[];
    };
    expect(carried.adapters[0].config).not.toHaveProperty('dmPolicy');
  });
});

// ---------------------------------------------------------------------------
// The carried-forward risk is stated out loud
// ---------------------------------------------------------------------------

describe('warnOnOpenDmPolicy', () => {
  const openSlack = {
    id: 'my-slack',
    type: 'slack',
    enabled: true,
    config: { dmPolicy: 'open' },
  };

  it('names the integration that anyone in the workspace can DM', () => {
    warnOnOpenDmPolicy([openSlack]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('my-slack');
  });

  it('stays quiet for an allowlisted integration', () => {
    warnOnOpenDmPolicy([{ ...openSlack, config: { dmPolicy: 'allowlist' } }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet for a disabled integration', () => {
    warnOnOpenDmPolicy([{ ...openSlack, enabled: false }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
