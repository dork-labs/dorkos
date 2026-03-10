import { describe, it, expect, vi, beforeEach } from 'vitest';

// Because version.ts uses top-level module constants, we need to re-import
// after changing mocks. Use vi.resetModules() between tests.

// Default mock: no override
vi.mock('../../env.js', () => ({
  env: {
    DORKOS_VERSION_OVERRIDE: undefined,
  },
}));

describe('version resolution', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses DORKOS_VERSION_OVERRIDE when set', async () => {
    vi.doMock('../../env.js', () => ({
      env: { DORKOS_VERSION_OVERRIDE: '1.5.0' },
    }));
    const { SERVER_VERSION } = await import('../version.js');
    expect(SERVER_VERSION).toBe('1.5.0');
  });

  it('is not dev build when DORKOS_VERSION_OVERRIDE is set', async () => {
    vi.doMock('../../env.js', () => ({
      env: { DORKOS_VERSION_OVERRIDE: '0.0.0' },
    }));
    const { IS_DEV_BUILD } = await import('../version.js');
    expect(IS_DEV_BUILD).toBe(false);
  });

  it('falls back to package.json version when no override or CLI version', async () => {
    vi.doMock('../../env.js', () => ({
      env: { DORKOS_VERSION_OVERRIDE: undefined },
    }));
    const { SERVER_VERSION } = await import('../version.js');
    // package.json has 0.0.0
    expect(SERVER_VERSION).toBe('0.0.0');
  });

  it('detects dev build when version is 0.0.0', async () => {
    vi.doMock('../../env.js', () => ({
      env: { DORKOS_VERSION_OVERRIDE: undefined },
    }));
    const { IS_DEV_BUILD } = await import('../version.js');
    expect(IS_DEV_BUILD).toBe(true);
  });
});
