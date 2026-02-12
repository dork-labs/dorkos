import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('platform adapter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to web adapter', async () => {
    const { getPlatform } = await import('../platform');
    expect(getPlatform().isEmbedded).toBe(false);
  });

  it('setPlatformAdapter overrides the active adapter', async () => {
    const { getPlatform, setPlatformAdapter } = await import('../platform');

    const custom = {
      isEmbedded: true,
      getSessionId: () => 'test-session',
      setSessionId: vi.fn(),
      openFile: vi.fn(),
    };

    setPlatformAdapter(custom);
    expect(getPlatform().isEmbedded).toBe(true);
    expect(getPlatform().getSessionId()).toBe('test-session');
  });

  it('web adapter openFile is a no-op', async () => {
    const { getPlatform } = await import('../platform');
    await expect(getPlatform().openFile('/some/path')).resolves.toBeUndefined();
  });
});
