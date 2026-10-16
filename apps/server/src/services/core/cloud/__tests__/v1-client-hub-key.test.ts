/**
 * Where an instance's DorkOS Cloud key comes from (DOR-2935): the config on a
 * person's own computer, the environment on a hub, where the config is never
 * consulted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
const mockEnv = vi.hoisted(() => ({
  DORKOS_HUB_INSTANCE_KEY: 'hub-key-from-the-environment' as string | undefined,
}));
const stored = vi.hoisted(() => ({ token: 'linked-key-in-config' as string | undefined }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'cloud' ? { instanceToken: stored.token } : undefined),
  },
}));

const { readCloudInstanceToken, isCloudLinked } = await import('../v1-client.js');

beforeEach(() => {
  role.value = 'hub';
  mockEnv.DORKOS_HUB_INSTANCE_KEY = 'hub-key-from-the-environment';
  stored.token = 'linked-key-in-config';
});

describe('the instance key', () => {
  it('is the environment`s on a hub, never the config`s', () => {
    expect(readCloudInstanceToken()).toBe('hub-key-from-the-environment');
    mockEnv.DORKOS_HUB_INSTANCE_KEY = undefined;
    expect(readCloudInstanceToken()).toBeNull();
    expect(isCloudLinked()).toBe(false);
  });

  it('is the config`s on a person`s own computer, never the environment`s', () => {
    role.value = 'computer';
    expect(readCloudInstanceToken()).toBe('linked-key-in-config');
    stored.token = undefined;
    expect(readCloudInstanceToken()).toBeNull();
  });
});
