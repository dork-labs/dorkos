import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import type { LocalBrowserState, LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import { BrowserHandover, type HandoverBrowser } from '../handover.js';
import type { SignInWindow } from '../sign-in-window.js';

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
    pause: vi.fn(async () => (state = { ...state, paused: true })),
    handToPerson: vi.fn(async () => (state = { ...state, paused: true })),
    resume: vi.fn(async () => (state = { ...state, paused: false })),
    disconnect: vi.fn(async () => (state = { ...state, status: 'disconnected', sessionId: null })),
  } satisfies HandoverBrowser;
  return {
    browser,
    set: (next: LocalBrowserState) => (state = next),
    setProfile: (id: string | null) => (profileId = id),
  };
}

export function fakeSignIns(): {
  signIns: {
    readonly current: LocalBrowserSignIn | null;
    readonly active: boolean;
    holds: (candidate: string) => boolean;
    start: Mock<
      (folder: string, profileId: string | null, url: string) => Promise<LocalBrowserSignIn>
    >;
    close: Mock;
    onChange: Mock;
  };
  finish: (next: 'saved' | 'failed') => void;
} {
  let status: 'open' | 'saving' | 'saved' | 'failed' | null = null;
  let folder: string | undefined;
  const signIns = {
    get current() {
      return status ? { profileId: null, site: 'x', status, startedAt: 'now' } : null;
    },
    get active() {
      return status === 'open' || status === 'saving';
    },
    holds: (candidate: string) =>
      (status === 'open' || status === 'saving') && candidate === folder,
    start: vi.fn(async (profileFolder: string, _profileId: string | null, _url: string) => {
      folder = profileFolder;
      status = 'open';
      return signIns.current!;
    }),
    close: vi.fn(),
    onChange: vi.fn(),
  };
  return { signIns, finish: (next: 'saved' | 'failed') => (status = next) };
}

export function setup(
  outside = false,
  mode: 'embedded' | 'new-window' = 'embedded'
): ReturnType<typeof fakeBrowser> & ReturnType<typeof fakeSignIns> & { handover: BrowserHandover } {
  const browser = fakeBrowser({ ...connected(), mode });
  const signIns = fakeSignIns();
  const handover = new BrowserHandover(
    browser.browser,
    signIns.signIns as unknown as SignInWindow,
    () => dataDirectory
  );
  handover.useOutsideTurnCheck(async () => outside);
  return { handover, ...browser, ...signIns };
}
