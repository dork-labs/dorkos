// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What a start with the default font asks the network for (DOR-4872). The
 * store reads the stored font when its module loads, so each case loads it
 * fresh.
 */
async function freshStore() {
  vi.resetModules();
  const { useAppStore } = await import('../app-store');
  return useAppStore;
}

const googleLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link')].filter((link) =>
    /fonts\.(googleapis|gstatic)\.com/.test(link.href)
  );

describe('the default font at start', () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('style');
  });

  // Purpose: with nothing stored, the app starts on the default font, shipped
  // with the app, and adds no Google stylesheet the page would wait on.
  it('adds no Google stylesheet when nothing is stored', async () => {
    const store = await freshStore();

    expect(store.getState().fontFamily).toBe('inter');
    expect(googleLinks()).toEqual([]);
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain("'Inter'");
  });

  // Purpose: a font a person picked in Settings still loads from Google.
  it('still loads a picked Google font', async () => {
    localStorage.setItem('dorkos-font-family', 'geist');

    await freshStore();

    expect(googleLinks().map((link) => link.href)).toEqual([
      expect.stringContaining('family=Geist'),
    ]);
  });

  // Purpose: picking the default again in Settings drops the Google stylesheet
  // the earlier pick added, so the next start and this page ask Google for nothing.
  it('drops the Google stylesheet when Settings switches back to the default', async () => {
    const store = await freshStore();

    store.getState().setFontFamily('geist');
    expect(googleLinks()).toHaveLength(1);

    store.getState().setFontFamily('inter');
    expect(googleLinks()).toEqual([]);
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain("'Inter'");
  });
});
