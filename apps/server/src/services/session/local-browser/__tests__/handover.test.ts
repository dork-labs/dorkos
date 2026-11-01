/** Handing the browser to a person and back, with a fake browser and a fake sign-in window. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { BrowserHandover, assertSignInUrl, type HandoverBrowser } from '../handover.js';
import type { SignInWindow } from '../sign-in-window.js';

let dataDirectory: string;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'handover-'));
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
    currentProfileId: vi.fn(() => profileId),
    open: vi.fn(async () => (state = connected())),
    selectTab: vi.fn(async () => state),
    pause: vi.fn(async () => (state = { ...state, paused: true })),
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
  };
  return { signIns, finish: (next: 'saved' | 'failed') => (status = next) };
}

function setup(outside = false) {
  const browser = fakeBrowser();
  const signIns = fakeSignIns();
  const handover = new BrowserHandover(
    browser.browser,
    signIns.signIns as unknown as SignInWindow,
    () => dataDirectory
  );
  handover.useOutsideTurnCheck(async () => outside);
  return { handover, ...browser, ...signIns };
}

describe('assertSignInUrl', () => {
  it('takes https anywhere and http only on this computer', () => {
    expect(assertSignInUrl('https://linear.app/').host).toBe('linear.app');
    expect(assertSignInUrl('http://localhost:3000/').host).toBe('localhost:3000');
    expect(assertSignInUrl('http://127.0.0.1/').host).toBe('127.0.0.1');
    for (const url of ['http://linear.app/', 'ftp://linear.app/', 'file:///etc/passwd', 'nope'])
      expect(() => assertSignInUrl(url)).toThrow(
        expect.objectContaining({ code: 'unsupported_address' })
      );
  });
});

describe('BrowserHandover.ask', () => {
  it('fails closed until startup says how to read a turn’s marks', async () => {
    const browser = fakeBrowser();
    const handover = new BrowserHandover(
      browser.browser,
      fakeSignIns().signIns as unknown as SignInWindow,
      () => dataDirectory
    );
    await expect(handover.ask('chat-1', 'wall')).rejects.toMatchObject({ code: 'outside_turn' });
  });

  it('refuses an outside turn without pausing or raising the window', async () => {
    const { handover, browser } = setup(true);
    await expect(handover.ask('chat-1', 'password')).rejects.toMatchObject({
      code: 'outside_turn',
    });
    expect(browser.pause).not.toHaveBeenCalled();
    expect(browser.selectTab).not.toHaveBeenCalled();
    expect((await handover.state()).handoff).toBeNull();
  });

  it('pauses, raises the window and names the site from the page’s own URL', async () => {
    const { handover, browser } = setup();
    const answer = await handover.ask('chat-1', 'password');
    expect(answer.site).toBe('accounts.example.com');
    expect(answer.next).toMatch(/End your turn/);
    expect(browser.pause).toHaveBeenCalledOnce();
    expect(browser.selectTab).toHaveBeenCalledWith('t1');
    expect((await handover.state()).handoff).toMatchObject({
      id: answer.handoffId,
      sessionId: 'chat-1',
      reason: 'password',
      site: 'accounts.example.com',
      outcome: null,
    });
  });

  it('answers a second ask with the same handoff', async () => {
    const { handover } = setup();
    const first = await handover.ask('chat-1', 'wall');
    expect((await handover.ask('chat-1', 'wall')).handoffId).toBe(first.handoffId);
  });

  it('keeps the agent out of the browser until the person hands it back', async () => {
    const { handover } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
    expect((await handover.state()).handoff?.outcome).toBe('handed-back');
  });
});

describe('BrowserHandover sign-in', () => {
  it('opens the agent page’s origin, closing the agent window on that profile first', async () => {
    const { handover, browser, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    expect(browser.disconnect).toHaveBeenCalledOnce();
    const [folder, profileId, url] = signIns.start.mock.calls[0]!;
    expect(folder).toBe(path.join(dataDirectory, 'browser-profiles', 'p1'));
    expect(profileId).toBe('p1');
    expect(url).toBe('https://accounts.example.com/');
  });

  it('uses the page the agent is on now, never one recorded earlier', async () => {
    const { handover, set, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    set(connected('https://login.other.example/'));
    await handover.signIn({ handoffId });
    expect(signIns.start.mock.calls[0]![2]).toBe('https://login.other.example/');
  });

  it('refuses a handoff sign-in on an http page off this computer', async () => {
    const browser = fakeBrowser(connected('http://shop.example/'));
    const plain = new BrowserHandover(
      browser.browser,
      fakeSignIns().signIns as unknown as SignInWindow,
      () => dataDirectory
    );
    plain.useOutsideTurnCheck(async () => false);
    const { handoffId } = await plain.ask('chat-1', 'password');
    await expect(plain.signIn({ handoffId })).rejects.toMatchObject({
      code: 'unsupported_address',
    });
  });

  it('refuses a sign-in for the embedded browser, whose cookies live elsewhere', async () => {
    const { handover, set } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    set({ ...connected(), mode: 'embedded' });
    await expect(handover.signIn({ handoffId })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps the agent out and Hand back closed until the sign-in is saved', async () => {
    const { handover, finish } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'signing_in' });
    finish('saved');
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('reopens the agent window for the same chat and page on Hand back', async () => {
    const { handover, browser, finish } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    finish('saved');
    await handover.handBack(handoffId);
    expect(browser.open).toHaveBeenCalledWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      profileId: 'p1',
      url: 'https://accounts.example.com/login?next=%2Fhome',
    });
    expect(browser.resume).not.toHaveBeenCalled();
  });

  it('blocks the agent on its profile while a person signs in there', async () => {
    const { handover } = setup();
    await handover.signIn({
      url: 'https://linear.app/',
      profileId: '00000000-0000-4000-8000-000000000001',
    });
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
    const other = setup();
    await other.handover.signIn({ url: 'https://linear.app/' });
    other.setProfile(null);
    await expect(other.handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'signing_in',
    });
  });

  it('won’t open a profile a sign-in holds', async () => {
    const { handover, browser } = setup();
    browser.open.mockClear();
    await handover.signIn({ url: 'https://linear.app/' });
    await expect(handover.open({ mode: 'new-window', sessionId: 'chat-1' })).rejects.toMatchObject({
      code: 'signing_in',
    });
    expect(browser.open).not.toHaveBeenCalled();
  });
});

describe('BrowserHandover answers', () => {
  it('Stop task ends the handoff and keeps the browser paused', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    const state = await handover.stop(handoffId);
    expect(state.handoff?.outcome).toBe('stopped');
    expect(state.paused).toBe(true);
    expect(browser.resume).not.toHaveBeenCalled();
  });

  it('refuses an answer to a handoff that already ended', async () => {
    const { handover } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.stop(handoffId);
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
    await expect(handover.stop('someone-else')).rejects.toMatchObject({ code: 'handoff_ended' });
  });

  it('a person’s Resume during a handoff hands the browser back', async () => {
    const { handover } = setup();
    await handover.ask('chat-1', 'wall');
    expect((await handover.resume()).handoff?.outcome).toBe('handed-back');
  });

  it('opening the browser for another chat ends this chat’s handoff', async () => {
    const { handover } = setup();
    await handover.ask('chat-1', 'wall');
    const state = await handover.open({ mode: 'new-window', sessionId: 'chat-2' });
    expect(state.handoff?.outcome).toBe('stopped');
  });
});
