/**
 * `applyConfigPatch` at a hub: turning login off is refused up front with the
 * hub's own sentence, so `PATCH /api/config` answers 400 rather than a 500
 * from the config store underneath.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

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

import { applyConfigPatch } from '../config-patch.js';
import { HUB_LOGIN_ALWAYS_ON } from '../../config/hub-settings.js';

describe('applyConfigPatch at a hub', () => {
  beforeEach(() => {
    role.value = 'hub';
    for (const key of Object.keys(stored)) delete stored[key];
    Object.assign(stored, { version: 1, auth: { enabled: true }, ui: { theme: 'dark' } });
  });

  it('refuses turning login off', () => {
    expect(applyConfigPatch({ auth: { enabled: false } })).toEqual({
      ok: false,
      error: HUB_LOGIN_ALWAYS_ON,
    });
  });

  it('passes a patch that leaves login alone', () => {
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
  });
});
