import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
      openFile: vi.fn(),
    };

    setPlatformAdapter(custom);
    expect(getPlatform().isEmbedded).toBe(true);
  });

  it('web adapter openFile is a no-op', async () => {
    const { getPlatform } = await import('../platform');
    await expect(getPlatform().openFile('/some/path')).resolves.toBeUndefined();
  });
});

describe('isDesktopDarwin', () => {
  afterEach(() => {
    document.documentElement.classList.remove('desktop-darwin');
  });

  it('is false when <html> lacks the desktop-darwin class', async () => {
    vi.resetModules();
    const { isDesktopDarwin } = await import('../platform');
    expect(isDesktopDarwin).toBe(false);
  });

  it('is true when <html> carries the desktop-darwin class (module load order matches the index.html bootstrap script)', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { isDesktopDarwin } = await import('../platform');
    expect(isDesktopDarwin).toBe(true);
  });
});
