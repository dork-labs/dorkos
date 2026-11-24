/** Handing the browser to a person and back: a fake browser, a fake sign-in window, and a throwaway data folder per test. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { type LocalBrowserState } from '@dorkos/shared/local-browser';
import { BrowserHandover, type HandoverBrowser } from '../../handover.js';
import type { SignInWindow } from '../../sign-in-window.js';

export let dataDirectory: string;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'handover-'));
});
afterEach(() => rmSync(dataDirectory, { recursive: true, force: true }));

export function connected(
  url = 'https://accounts.example.com/login?next=%2Fhome'
): LocalBrowserState {
  return {
    connectionId: 'c1',
    sessionId: 'chat-1',
    mode: 'new-window',
    status: 'connected',
    paused: false,
    tabs: [{ id: 't1', url, title: 'Sign in' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
  };
}

export function fakeBrowser(initial = connected()) {
  let state = initial;
  let profileId: string | null = 'p1';
  const browser = {
    state: vi.fn(async () => state),
    capabilities: vi.fn(() => ({ newWindow: true })),
    currentProfileId: vi.fn(() => profileId),
    profileExists: vi.fn((_id: string) => true),
    open: vi.fn(async () => (state = connected())),
    selectTab: vi.fn(async () => state),
    navigate: vi.fn(async () => state),
    stepHistory: vi.fn(async () => state),
    pause: vi.fn(async () => (state = { ...state, paused: true })),
    handToPerson: vi.fn<HandoverBrowser['handToPerson']>(
      async () => (state = { ...state, paused: true })
    ),
    resume: vi.fn(async () => (state = { ...state, paused: false })),
    disconnect: vi.fn(async () => (state = { ...state, status: 'disconnected', sessionId: null })),
  } satisfies HandoverBrowser;
  return {
    browser,
    set: (next: LocalBrowserState) => (state = next),
    setProfile: (id: string | null) => (profileId = id),
  };
}

export function fakeSignIns() {
  let status: 'open' | 'saving' | 'saved' | 'failed' | null = null;
  let folder: string | undefined;
  const signIns = {
    get current() {
      return status
        ? { profileId: null, site, status, startedAt: '2999-01-01T00:00:00.000Z' }
        : null;
    },
    get active() {
      return status === 'open' || status === 'saving';
    },
    holds: (candidate: string) =>
      (status === 'open' || status === 'saving') && candidate === folder,
    start: vi.fn(
      async (
        profileFolder: string,
        _profileId: string | null,
        _url: string,
        admission?: { require(): Promise<void>; assertCurrent(): void }
      ) => {
        await admission?.require();
        admission?.assertCurrent();
        folder = profileFolder;
        status = 'open';
        return signIns.current!;
      }
    ),
    // Like the real one: only an open window is asked to quit, and its save then lands.
    done: vi.fn(() => {
      if (status !== 'open') return;
      status = doneLandsAs;
      moved();
    }),
    onChange: vi.fn((listener: () => void) => {
      moved = listener;
    }),
  };
  let doneLandsAs: 'saved' | 'failed' = 'saved';
  // The asked page's host, so a sign-in reads as this handoff's own unless a test says not.
  let site = 'accounts.example.com';
  let moved: () => void = () => undefined;
  return {
    signIns,
    finish: (next: 'saved' | 'failed') => (status = next),
    doneLandsAs: (next: 'saved' | 'failed') => (doneLandsAs = next),
    signInSite: (next: string) => (site = next),
  };
}

export function setup(outside = false, mode: 'embedded' | 'new-window' = 'embedded') {
  const browser = fakeBrowser({ ...connected(), mode });
  const signIns = fakeSignIns();
  const handover = new BrowserHandover(
    browser.browser,
    signIns.signIns as unknown as SignInWindow,
    () => dataDirectory
  );
  handover.useOutsideTurnCheck(async () => (outside ? 'outsider_turn' : null));
  // As startup does: a sign-in that moves reaches the handoff (DOR-4731).
  handover.useChangeListener(() => undefined);
  return { handover, ...browser, ...signIns };
}
