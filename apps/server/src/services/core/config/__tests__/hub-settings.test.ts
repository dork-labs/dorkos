import { beforeEach, describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

import { HUB_LOGIN_ALWAYS_ON, hubPinnedRead, hubSettingRefusal } from '../hub-settings.js';

describe('hub settings', () => {
  beforeEach(() => {
    role.value = 'computer';
  });

  it('changes nothing on a person`s own computer', () => {
    const auth = { enabled: false };
    expect(hubPinnedRead('auth', auth)).toBe(auth);
    expect(hubPinnedRead('auth.enabled', false)).toBe(false);
    expect(hubSettingRefusal('auth', { enabled: false })).toBeNull();
    expect(hubSettingRefusal('auth.enabled', false)).toBeNull();
  });

  it('reads login as on at a hub, whatever the file says', () => {
    role.value = 'hub';
    expect(hubPinnedRead('auth', { enabled: false, other: 1 })).toEqual({
      enabled: true,
      other: 1,
    });
    expect(hubPinnedRead('auth', undefined)).toEqual({ enabled: true });
    expect(hubPinnedRead('auth.enabled', false)).toBe(true);
    expect(hubPinnedRead('ui', { theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  it('refuses turning login off at a hub, and allows every other write', () => {
    role.value = 'hub';
    expect(hubSettingRefusal('auth', { enabled: false })).toBe(HUB_LOGIN_ALWAYS_ON);
    expect(hubSettingRefusal('auth.enabled', false)).toBe(HUB_LOGIN_ALWAYS_ON);
    expect(hubSettingRefusal('auth', { enabled: true })).toBeNull();
    expect(hubSettingRefusal('auth', undefined)).toBeNull();
    expect(hubSettingRefusal('ui', { enabled: false })).toBeNull();
  });
});
