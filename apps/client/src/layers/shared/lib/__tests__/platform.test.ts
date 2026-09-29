import { describe, it, expect, afterEach, vi } from 'vitest';

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
