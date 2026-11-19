/** Security's proof (DOR-4693 PR 2 review), turned to the fixed behaviour: a sign-in that fails to start leaves no reopen behind. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { BrowserHandover, type HandoverBrowser } from '../handover.js';
import type { SignInWindow } from '../sign-in-window.js';
import { LocalBrowserError } from '../errors.js';

let dataDirectory: string;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'sec-handover-'));
});
afterEach(() => rmSync(dataDirectory, { recursive: true, force: true }));
function connected(url = 'https://accounts.example.com/login?next=%2Fhome'): LocalBrowserState {
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

function fakeBrowser(initial = connected()) {
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

function fakeSignIns() {
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

describe('DOR-4693: a failed sign-in start forgets the window it would reopen', () => {
  it('never reopens chat-1’s old window after a later, unrelated sign-in', async () => {
    const b = fakeBrowser({ ...connected(), mode: 'new-window' });
    b.setProfile(null);
    const s = fakeSignIns();
    const handover = new BrowserHandover(
      b.browser,
      s.signIns as unknown as SignInWindow,
      () => dataDirectory
    );
    handover.useOutsideTurnCheck(async () => null);
    handover.useChangeListener(vi.fn());
    const moved = () => (s.signIns.onChange.mock.calls[0]![0] as () => void)();
    // 1. The person's sign-in from the agent's own window hits profile_busy at the isHeld check (no change event).
    s.signIns.start.mockRejectedValueOnce(new LocalBrowserError('profile_busy', 'busy'));
    await expect(handover.signIn({ url: 'https://accounts.example.com/' })).rejects.toThrow();
    expect(b.browser.disconnect).toHaveBeenCalledOnce();
    // 2. Browser stays closed (the person's choice). Later the person signs in again, on a closed browser.
    await handover.signIn({ url: 'https://other.example.com/' });
    s.finish('saved');
    moved();
    // 3. chat-1's old page stays closed: the person's choice stands.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.browser.open).not.toHaveBeenCalled();
  });
});
