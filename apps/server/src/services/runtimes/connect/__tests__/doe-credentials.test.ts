/** @vitest-environment node */
import { expect, it, vi } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import type { ConfigReadWrite } from '../persist-provider-credential.js';
vi.mock('../../../audit/audit-trail.js', async (original) => ({
  ...(await original<typeof import('../../../audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));
import { recordAudit } from '../../../audit/audit-trail.js';
import { logger } from '../../../../lib/logger.js';
import { storeDoeCredential } from '../doe-credentials.js';
const inference = {
  source: 'api-key' as const,
  provider: 'fixture',
  protocol: 'openai-chat-completions' as const,
  endpoint: 'http://127.0.0.1:4444/v1',
  model: 'fixture',
  contextWindow: 8192,
  maxOutputTokens: 100,
};
function fixture() {
  const state = UserConfigSchema.parse({ version: 1 });
  const config: ConfigReadWrite = {
    get: (key) => state[key],
    set: (key, value) => {
      state[key] = value;
    },
  };
  return {
    config,
    state,
    store: {
      put: vi.fn(async () => 'file:fixture-key'),
      delete: vi.fn(async () => {}),
      get: vi.fn(),
    },
  };
}
it('audits successful encrypted-key references in both changed sections without recording the plaintext key', async () => {
  vi.mocked(recordAudit).mockClear();
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  const { config, store, state } = fixture();
  try {
    await storeDoeCredential(inference, 'offline-never-record-key', { config, store });
    expect(store.put).toHaveBeenCalledWith(expect.any(String), 'offline-never-record-key');
    expect(recordAudit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordAudit).mock.calls.map(([entry]) => entry.summary)).toEqual([
      expect.stringContaining('the DorkOS API key setup'),
      expect.stringContaining('the DorkOS API key setup'),
    ]);
    expect(vi.mocked(recordAudit).mock.calls.flatMap(([entry]) => entry.change ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/^providers\./) }),
        expect.objectContaining({ field: expect.stringMatching(/^runtimes\.doe\.inference/) }),
      ])
    );
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain(
      'offline-never-record-key'
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('offline-never-record-key');
    expect(JSON.stringify(state)).not.toContain('offline-never-record-key');
  } finally {
    info.mockRestore();
  }
});
it('rolls back failed setup and leaves no successful config audit', async () => {
  vi.mocked(recordAudit).mockClear();
  const { config, state, store } = fixture();
  const set = config.set.bind(config);
  let fail = true;
  config.set = (key, value) => {
    if (key === 'runtimes' && fail) {
      fail = false;
      throw new Error('fixture write failed');
    }
    set(key, value);
  };
  await expect(storeDoeCredential(inference, 'offline-key', { config, store })).rejects.toThrow(
    'Could not save'
  );
  expect(state.providers).toEqual({});
  expect(state.runtimes.doe.inference).toBeNull();
  expect(store.delete).toHaveBeenCalledWith('fixture-key');
  expect(recordAudit).not.toHaveBeenCalled();
});

for (const failWrite of [false, true]) {
  it(`${failWrite ? 'rolls back to' : 'preserves'} the current settings changed while the encrypted store is pending`, async () => {
    vi.mocked(recordAudit).mockClear();
    const { config, state, store } = fixture();
    let release!: (ref: string) => void;
    store.put.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const reads = vi.spyOn(config, 'get');
    const set = config.set.bind(config);
    let fail = failWrite;
    config.set = (key, value) => {
      if (key === 'runtimes' && fail) {
        fail = false;
        throw new Error('fixture write failed');
      }
      set(key, value);
    };
    const pending = storeDoeCredential(inference, 'offline-key', { config, store });
    const readsBeforeStored = reads.mock.calls.length;
    state.providers = { unrelated: 'env:UNRELATED_FIXTURE' };
    state.runtimes = {
      ...state.runtimes,
      defaultTrustStop: 'act',
      doe: { ...state.runtimes.doe, enabled: false, defaultTrustStop: 'ask' },
    };
    const beforeRuntimes = state.runtimes;
    const beforeProviders = state.providers;
    const outcome = failWrite ? expect(pending).rejects.toThrow('Could not save') : pending;
    release('file:fixture-key');
    await outcome;
    expect(state.providers.unrelated).toBe('env:UNRELATED_FIXTURE');
    expect(state.runtimes).toMatchObject({
      defaultTrustStop: 'act',
      doe: { enabled: false, defaultTrustStop: 'ask' },
    });
    expect(readsBeforeStored).toBe(0);
    if (failWrite) {
      expect(state.runtimes).toEqual(beforeRuntimes);
      expect(state.providers).toEqual(beforeProviders);
      expect(store.delete).toHaveBeenCalledWith('fixture-key');
      expect(recordAudit).not.toHaveBeenCalled();
    } else {
      const fields = vi
        .mocked(recordAudit)
        .mock.calls.flatMap(([entry]) => entry.change?.map((change) => change.field) ?? []);
      expect(fields).not.toContain('providers.unrelated');
      expect(fields).not.toContain('runtimes.doe.enabled');
      expect(fields).not.toContain('runtimes.doe.defaultTrustStop');
      expect(fields).not.toContain('runtimes.defaultTrustStop');
      expect(store.delete).not.toHaveBeenCalled();
    }
  });
}
for (const section of ['providers', 'runtimes'] as const) {
  it(`deletes the new encrypted reference when the post-store ${section} config read throws`, async () => {
    vi.mocked(recordAudit).mockClear();
    const { config, store } = fixture();
    const get = config.get.bind(config);
    config.get = (key) => {
      if (key === section) throw new Error('fixture read failed');
      return get(key);
    };
    const writes = vi.spyOn(config, 'set');
    await expect(storeDoeCredential(inference, 'offline-key', { config, store })).rejects.toThrow(
      'Could not save'
    );
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith('fixture-key');
    expect(writes).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
}
