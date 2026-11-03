/** Handing the browser to a person and back, with a fake browser and a fake sign-in window. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
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
    capabilities: vi.fn(() => ({ newWindow: true })),
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
    onChange: vi.fn(),
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
    handover.useAgentIdLookup((folder) => (folder === '/agents/ana' ? 'agent-ana' : undefined));
    const answer = await handover.ask('chat-1', 'password', { name: 'Ana', folder: '/agents/ana' });
    expect(answer.site).toBe('accounts.example.com');
    expect(answer.next).toMatch(/End your turn/);
    expect(browser.pause).toHaveBeenCalledOnce();
    expect(browser.selectTab).toHaveBeenCalledWith('t1');
    expect((await handover.state()).handoff).toMatchObject({
      id: answer.handoffId,
      sessionId: 'chat-1',
      agentName: 'Ana',
      agentId: 'agent-ana',
      agentFolder: '/agents/ana',
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

  it('refuses when the page left the site the card names', async () => {
    const { handover, set, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    set(connected('https://login.other.example/'));
    await expect(handover.signIn({ handoffId })).rejects.toMatchObject({ code: 'site_changed' });
    expect(signIns.start).not.toHaveBeenCalled();
  });

  it('opens the origin of the page the agent is on now, on the same site', async () => {
    const { handover, set, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    set(connected('https://accounts.example.com/other/step'));
    await handover.signIn({ handoffId });
    expect(signIns.start.mock.calls[0]![2]).toBe('https://accounts.example.com/');
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
  it('Stop task ends the handoff, pauses, and keeps that chat out of the browser', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    const state = await handover.stop(handoffId);
    expect(state.handoff?.outcome).toBe('stopped');
    expect(state.paused).toBe(true);
    expect(browser.resume).not.toHaveBeenCalled();
    // The person may now do 2FA or a payment in that window: the chat reads nothing.
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'task_stopped',
    });
    await expect(handover.ask('chat-1', 'wall')).rejects.toMatchObject({ code: 'task_stopped' });
    expect(browser.selectTab).toHaveBeenCalledOnce();
  });

  it('a person opening or resuming the browser lets the stopped chat back in', async () => {
    const opened = setup();
    await opened.handover.stop((await opened.handover.ask('chat-1', 'wall')).handoffId);
    await opened.handover.open({ mode: 'new-window', sessionId: 'chat-1' });
    await expect(opened.handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
    const resumed = setup();
    await resumed.handover.stop((await resumed.handover.ask('chat-1', 'wall')).handoffId);
    await resumed.handover.resume();
    await expect(resumed.handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
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

  it('sharing with another chat mid-handoff closes the old card, whose Continue is then refused', async () => {
    const { handover } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.open({ mode: 'new-window', sessionId: 'chat-2' });
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
    await expect(handover.stop(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
  });
});

describe('telling the app something changed', () => {
  function wired(state = connected()) {
    const { browser } = fakeBrowser(state);
    const { signIns } = fakeSignIns();
    const handover = new BrowserHandover(
      browser,
      signIns as unknown as SignInWindow,
      () => dataDirectory
    );
    handover.useOutsideTurnCheck(async () => false);
    const changed = vi.fn();
    handover.useChangeListener(changed);
    const handedOver = vi.fn();
    handover.useHandoffListener(handedOver);
    return { handover, signIns, changed, handedOver };
  }

  it('hands the same listener to the sign-in window', () => {
    const { signIns, changed } = wired();
    expect(signIns.onChange).toHaveBeenCalledWith(changed);
  });

  it('says so when a handoff starts, once, and not on a repeat ask', async () => {
    const { handover, changed } = wired();
    await handover.ask('chat-1', 'wall');
    expect(changed).toHaveBeenCalledTimes(1);
    await handover.ask('chat-1', 'wall');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('says so after the record has the outcome, on Hand back and on Stop task', async () => {
    for (const answer of ['handBack', 'stop'] as const) {
      const { handover, changed } = wired();
      const { handoffId } = await handover.ask('chat-1', 'wall');
      changed.mockClear();
      let outcomeWhenTold: unknown;
      changed.mockImplementation(async () => {
        outcomeWhenTold = (await handover.state()).handoff?.outcome;
      });
      await handover[answer](handoffId);
      expect(changed).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(outcomeWhenTold).toBeTruthy());
    }
  });

  it('records each new handoff once, not on a repeat ask or an answer', async () => {
    const { handover, handedOver } = wired();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.ask('chat-1', 'wall');
    await handover.handBack(handoffId);
    expect(handedOver).toHaveBeenCalledTimes(1);
    expect(handedOver.mock.calls[0]![0]).toMatchObject({ id: handoffId, outcome: null });
  });

  it('logs the handoff, each agent call it refuses, and how it ended, for QA to read', async () => {
    const info = vi.spyOn(logger, 'info');
    const { handover } = wired();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toThrow();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toThrow();
    await handover.handBack(handoffId);
    expect(info.mock.calls.map(([message]) => message)).toEqual([
      '[Browser] An agent handed the browser to a person',
      '[Browser] Refused an agent call during a handoff',
      '[Browser] Refused an agent call during a handoff',
      '[Browser] A browser handoff ended',
    ]);
    info.mockRestore();
  });

  it('says nothing when an outside turn is refused', async () => {
    const { handover, changed } = wired();
    handover.useOutsideTurnCheck(async () => true);
    await expect(handover.ask('chat-1', 'wall')).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('signing in from the Mac app’s built-in browser', () => {
  const embedded = () => ({ ...connected(), mode: 'embedded' as const });
  function panel() {
    const fake = fakeBrowser(embedded());
    fake.setProfile(null);
    const { signIns, finish } = fakeSignIns();
    const handover = new BrowserHandover(
      fake.browser,
      signIns as unknown as SignInWindow,
      () => dataDirectory
    );
    handover.useOutsideTurnCheck(async () => false);
    return { ...fake, signIns, finish, handover };
  }

  it('really closes the panel’s browser before the plain window opens', async () => {
    const { handover, browser, signIns } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(browser.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      signIns.start.mock.invocationCallOrder[0]!
    );
    expect(signIns.start.mock.calls[0]![0]).toMatch(/browser-profiles[\\/]default$/);
  });

  it('opens no plain window if the panel didn’t close', async () => {
    const { handover, browser, signIns } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    browser.disconnect.mockRejectedValueOnce(new Error('stuck'));
    await expect(handover.signIn({ handoffId })).rejects.toThrow();
    expect(signIns.start).not.toHaveBeenCalled();
  });

  it('refuses every chat’s agent calls from Sign in until the window is back', async () => {
    const { handover, finish } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
    // The window holds the default profile, which is the one the agent would come back to.
    await expect(handover.requireAgentMayUse('chat-2')).rejects.toMatchObject({
      code: 'signing_in',
    });
    finish('saved');
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('refuses a share with another chat in a new window while the person signs in', async () => {
    const { handover, browser } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    browser.open.mockClear();
    await expect(handover.open({ mode: 'new-window', sessionId: 'chat-2' })).rejects.toMatchObject({
      code: 'signing_in',
    });
    expect(browser.open).not.toHaveBeenCalled();
    expect((await handover.state()).handoff?.outcome).toBeNull();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
  });

  it('a person sharing the panel with another chat mid-sign-in ends the handoff, and that chat waits for the window', async () => {
    const { handover, finish } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    const state = await handover.open({ mode: 'embedded', sessionId: 'chat-2' });
    expect(state.handoff?.outcome).toBe('stopped');
    await expect(handover.requireAgentMayUse('chat-2')).rejects.toMatchObject({
      code: 'signing_in',
    });
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
    finish('saved');
    await expect(handover.requireAgentMayUse('chat-2')).resolves.toBeUndefined();
  });

  it('Continue reopens in a new window at the page saved when the handoff began', async () => {
    const { handover, browser, finish, set } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    set({ ...embedded(), status: 'disconnected', sessionId: null, tabs: [], selectedTabId: null });
    finish('saved');
    await handover.handBack(handoffId);
    expect(browser.open).toHaveBeenCalledExactlyOnceWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      url: 'https://accounts.example.com/login?next=%2Fhome',
    });
  });

  it('keeps the page from when it asked, not one the agent moved to on the same site', async () => {
    const { handover, browser, finish, set } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    set({
      ...embedded(),
      tabs: [{ id: 't1', url: 'https://accounts.example.com/other', title: 'Moved' }],
    });
    await handover.signIn({ handoffId });
    set({ ...embedded(), status: 'disconnected', sessionId: null, tabs: [], selectedTabId: null });
    finish('saved');
    await handover.handBack(handoffId);
    expect(browser.open.mock.calls[0]).toEqual([
      expect.objectContaining({ url: 'https://accounts.example.com/login?next=%2Fhome' }),
    ]);
  });

  it('leaves the handoff open when the reopened window isn’t orange', async () => {
    const { handover, browser, finish, set } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    set({ ...embedded(), status: 'disconnected', sessionId: null, tabs: [], selectedTabId: null });
    finish('saved');
    browser.open.mockRejectedValueOnce(
      Object.assign(new Error('no frame'), { code: 'window_unlabelled' })
    );
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({
      code: 'window_unlabelled',
    });
    expect((await handover.state()).handoff?.outcome).toBeNull();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
  });

  it('refuses before closing anything where a new window can’t open', async () => {
    const { handover, browser } = panel();
    browser.capabilities.mockReturnValue({ newWindow: false });
    const { handoffId } = await handover.ask('chat-1', 'password');
    await expect(handover.signIn({ handoffId })).rejects.toMatchObject({ code: 'unsupported' });
    expect(browser.disconnect).not.toHaveBeenCalled();
  });
});
