/**
 * The surfaces a sealed agent computer turns off (DOR-2940): settings writes,
 * the client build, inline files and schedules. Each asks a person's own computer too, so a stub that refuses
 * everything cannot pass.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../../../env.js', () => ({
  env: { NODE_ENV: 'production', CLIENT_DIST_PATH: '/srv/app' },
}));
const stored: Record<string, unknown> = {};
vi.mock('../../config-manager.js', () => ({
  configManager: {
    getAll: vi.fn(() => structuredClone(stored)),
    get: vi.fn((key: string) => structuredClone(stored)[key]),
    set: vi.fn((key: string, value: unknown) => {
      stored[key] = value;
    }),
  },
}));

const { applyConfigPatch } = await import('../../operator/config-patch.js');
const { clientDistPath } = await import('../../../../http/client-dist.js');
const { servesInlineHere } = await import('../../../../lib/file-route-guards.js');
const { AGENT_COMPUTER_SETTINGS_REFUSAL, runsSchedules } = await import('../sealed.js');

beforeEach(() => {
  role.value = 'agent-computer';
  for (const key of Object.keys(stored)) delete stored[key];
  Object.assign(stored, { version: 1, ui: { theme: 'dark' } });
});

describe('settings on an agent computer', () => {
  it('refuses every write through the settings patch', () => {
    expect(applyConfigPatch({ ui: { theme: 'light' } })).toEqual({
      ok: false,
      error: AGENT_COMPUTER_SETTINGS_REFUSAL,
    });
    role.value = 'computer';
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
  });
});

describe('what an agent computer serves', () => {
  it('serves no client build', () => {
    expect(clientDistPath()).toBeUndefined();
    role.value = 'computer';
    expect(clientDistPath()).toBe('/srv/app');
  });

  it('shows only passive media inline, as a hub does', () => {
    expect(servesInlineHere('image/svg+xml')).toBe(false);
    expect(servesInlineHere('image/png')).toBe(true);
    role.value = 'computer';
    expect(servesInlineHere('image/svg+xml')).toBe(true);
  });

  it('runs nothing on its own clock', () => {
    expect(runsSchedules()).toBe(false);
    role.value = 'hub';
    expect(runsSchedules()).toBe(true);
  });
});
