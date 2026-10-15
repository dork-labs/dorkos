// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';
import { useAppStore } from '../app-store';
import { readLocalBrowserChoice } from '../local-browser-preference';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: null });
});
afterEach(() => vi.restoreAllMocks());
describe('local browser choice preference', () => {
  it('stores only mode/channel and restores them when the preference slice reloads', async () => {
    useAppStore.getState().setLocalBrowserChoice({ mode: 'existing', channel: 'msedge' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE)!)).toEqual({
      mode: 'existing',
      channel: 'msedge',
    });
    expect(readLocalBrowserChoice()).toEqual({
      choice: { mode: 'existing', channel: 'msedge' },
      issue: null,
    });
    vi.resetModules();
    const reloaded = await import('../app-store');
    expect(reloaded.useAppStore.getState().localBrowserChoice).toEqual({
      mode: 'existing',
      channel: 'msedge',
    });
  });
  it.each([
    '{broken',
    '{"mode":"retired-mode","channel":"chrome"}',
    '{"mode":"existing","channel":"unknown"}',
    '{"mode":"existing","channel":"chrome","consent":true}',
  ])(
    'rejects malformed or stale preferences without silently selecting another mode (%s)',
    (raw) => {
      localStorage.setItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE, raw);
      expect(readLocalBrowserChoice()).toEqual({ choice: null, issue: 'invalid' });
    }
  );
  it('reports unavailable storage without exposing its error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private storage details');
    });
    expect(readLocalBrowserChoice()).toEqual({ choice: null, issue: 'unavailable' });
  });
  it('keeps an explicit choice in memory when persistence is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private storage details');
    });
    useAppStore.getState().setLocalBrowserChoice({ mode: 'new-window', channel: 'chrome' });
    expect(useAppStore.getState().localBrowserChoice).toEqual({
      mode: 'new-window',
      channel: 'chrome',
    });
    expect(useAppStore.getState().localBrowserChoiceIssue).toBe('unsaved');
  });
  it('preserves browser choice on appearance reset and clears it on all-settings reset', () => {
    useAppStore.getState().setLocalBrowserChoice({ mode: 'existing', channel: 'msedge' });
    useAppStore.getState().resetAppearance();
    expect(readLocalBrowserChoice().choice).toEqual({ mode: 'existing', channel: 'msedge' });
    useAppStore.getState().resetAllSettings();
    expect(useAppStore.getState().localBrowserChoice).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE)).toBeNull();
  });
});
