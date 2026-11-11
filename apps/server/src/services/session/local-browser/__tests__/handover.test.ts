/** Handing the browser to a person and back, with a fake browser and a fake sign-in window. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../../lib/logger.js';
import { BrowserHandover, assertSignInUrl, type HandoverBrowser } from '../handover.js';
import { HANDED_BACK_MESSAGE, handBackWake } from '../hand-back-wake/index.js';

// The wake's dispatcher, so a hand back here starts no real turn (DOR-3112).
const dispatch = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));
vi.mock('../../launch/launch-session.js', () => ({
  dispatchSessionMessage: dispatch,
  isSessionLaunchRefusal: () => false,
}));
import { BrowserProfileRemoval } from '../profile-removal/index.js';
import { prepareProfileFolder } from '../profile-folders.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';
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
    navigate: vi.fn(async () => state),
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

describe('BrowserHandover end listener (DOR-3112)', () => {
  const listening = () => {
    const s = setup();
    const ended = vi.fn();
    s.handover.useEndListener(ended);
    return { ...s, ended };
  };

  it('tells it once on Continue, with the outcome on the record it gets', async () => {
    const { handover, ended } = listening();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.handBack(handoffId);
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
    expect(ended).toHaveBeenCalledOnce();
    expect(ended.mock.calls[0]![0]).toMatchObject({
      id: handoffId,
      sessionId: 'chat-1',
      outcome: 'handed-back',
    });
  });

  it('tells it handed back when the person resumes the browser instead', async () => {
    const { handover, ended } = listening();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.resume();
    expect(ended).toHaveBeenCalledOnce();
    expect(ended.mock.calls[0]![0]).toMatchObject({ id: handoffId, outcome: 'handed-back' });
  });

  it('tells it stopped on Stop task, and window-closed on Disconnect', async () => {
    const stopped = listening();
    const { handoffId } = await stopped.handover.ask('chat-1', 'wall');
    await stopped.handover.stop(handoffId);
    expect(stopped.ended.mock.calls.map(([h]) => h.outcome)).toEqual(['stopped']);

    const closed = listening();
    await closed.handover.ask('chat-1', 'wall');
    await closed.handover.disconnect();
    expect(closed.ended.mock.calls.map(([h]) => h.outcome)).toEqual(['window-closed']);
  });

  it('wakes the chat with fixed text that carries nothing from the page', async () => {
    const s = setup();
    s.set({
      ...connected('https://accounts.example.com/login?next=%2Fbilling&token=made-up'),
      tabs: [
        {
          id: 't1',
          url: 'https://accounts.example.com/login?next=%2Fbilling&token=made-up',
          title: 'Made-up Shop: verify you are human',
        },
      ],
    });
    dispatch.mockClear();
    s.handover.useEndListener(
      handBackWake({ meshCore: () => undefined, roomSessionPlace: () => undefined })
    );
    const { handoffId } = await s.handover.ask('chat-1', 'wall');
    await s.handover.handBack(handoffId);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const [opts] = dispatch.mock.calls[0] as unknown as [{ request: { content: string } }];
    expect(opts.request.content).toBe(HANDED_BACK_MESSAGE);
    const sent = JSON.stringify(opts);
    for (const fromPage of ['accounts.example.com', '/login', 'made-up', 'verify you are human'])
      expect(sent).not.toContain(fromPage);
  });

  it('says nothing when there is no handoff to end, or the window closes on its own', async () => {
    const { handover, ended } = listening();
    await handover.resume();
    await handover.disconnect();
    expect(ended).not.toHaveBeenCalled();
    await handover.open({ mode: 'new-window', sessionId: 'chat-1' });
    await handover.ask('chat-1', 'wall');
    // A window that closes by itself leaves the handoff open, so the card can reopen it.
    handover.windowClosed();
    expect(ended).not.toHaveBeenCalled();
    expect((await handover.state()).handoff?.outcome).toBeNull();
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

  it('refuses to open the browser for another chat, or none, during a handoff', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    browser.open.mockClear();
    for (const input of [{ sessionId: 'chat-2' }, {}])
      await expect(handover.open({ mode: 'new-window', ...input })).rejects.toMatchObject({
        code: 'handoff_open',
      });
    await expect(handover.open({ mode: 'embedded', sessionId: 'chat-2' })).rejects.toMatchObject({
      code: 'handoff_open',
    });
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect((await handover.state()).handoff?.outcome).toBeNull();
    await expect(handover.handBack(handoffId)).resolves.toBeDefined();
  });

  it('lets another chat open the browser once the handoff has ended', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.stop(handoffId);
    await handover.open({ mode: 'new-window', sessionId: 'chat-2' });
    expect(browser.open).toHaveBeenCalled();
  });

  it('a closed window reopens at the saved page, with the agent still out', async () => {
    const { handover, browser, set } = setup();
    await handover.ask('chat-1', 'wall');
    set({ ...connected(), status: 'closed', tabs: [], selectedTabId: null });
    browser.pause.mockClear();
    await handover.open({ mode: 'new-window', sessionId: 'chat-1', url: 'https://other.test/' });
    expect(browser.open).toHaveBeenCalledExactlyOnceWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      url: 'https://accounts.example.com/login?next=%2Fhome',
    });
    expect(browser.pause).toHaveBeenCalledOnce();
    expect((await handover.state()).handoff?.outcome).toBeNull();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
  });

  it('with no handoff open, takes the address a person chose', async () => {
    const { handover, browser } = setup();
    await handover.open({ mode: 'new-window', sessionId: 'chat-1', url: 'https://other.test/' });
    expect(browser.open).toHaveBeenCalledExactlyOnceWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      url: 'https://other.test/',
    });
    expect(browser.pause).not.toHaveBeenCalled();
  });

  it('a person can clear a handoff whose chat and window have gone', async () => {
    const { handover, browser, set } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    set({ ...connected(), status: 'disconnected', sessionId: null, tabs: [], selectedTabId: null });
    expect((await handover.stop(handoffId)).handoff?.outcome).toBe('stopped');
    expect(browser.disconnect).not.toHaveBeenCalled();
  });
});

describe('a person’s own browser controls during a handoff', () => {
  it('Disconnect ends the handoff as Stop task does, and that chat stays out', async () => {
    const { handover, browser } = setup();
    await handover.ask('chat-1', 'wall');
    const state = await handover.disconnect();
    expect(browser.disconnect).toHaveBeenCalledOnce();
    // Its own outcome, so the card can say the window closed (DOR-3112).
    expect(state.handoff?.outcome).toBe('window-closed');
    expect(state.status).toBe('disconnected');
    expect(() => handover.refuseStopped('chat-1')).toThrow(
      expect.objectContaining({ code: 'task_stopped' })
    );
    await expect(handover.ask('chat-1', 'wall')).rejects.toMatchObject({ code: 'task_stopped' });
    await handover.open({ mode: 'new-window', sessionId: 'chat-1' });
    expect(() => handover.refuseStopped('chat-1')).not.toThrow();
  });

  it('Disconnect leaves the card up if the window won’t close', async () => {
    const { handover, browser } = setup();
    await handover.ask('chat-1', 'wall');
    browser.disconnect.mockRejectedValueOnce(new Error('still closing'));
    await expect(handover.disconnect()).rejects.toThrow('still closing');
    expect((await handover.state()).handoff?.outcome).toBeNull();
    expect(() => handover.refuseStopped('chat-1')).not.toThrow();
  });

  it('Disconnect with no handoff stops nobody', async () => {
    const { handover, browser } = setup();
    expect((await handover.disconnect()).handoff).toBeNull();
    expect(browser.disconnect).toHaveBeenCalledOnce();
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('refuses a new address and another tab, and lets Show window raise the agent’s tab', async () => {
    const { handover, browser } = setup();
    await handover.ask('chat-1', 'wall');
    browser.selectTab.mockClear();
    await expect(handover.navigate('https://other.example/')).rejects.toMatchObject({
      code: 'handoff_open',
    });
    await expect(handover.selectTab('t2')).rejects.toMatchObject({ code: 'handoff_open' });
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(browser.selectTab).not.toHaveBeenCalled();
    await handover.selectTab('t1');
    expect(browser.selectTab).toHaveBeenCalledExactlyOnceWith('t1');
  });

  it('takes a new address and any tab once the handoff has ended, or with none open', async () => {
    const { handover, browser } = setup();
    await handover.selectTab('t2');
    await handover.navigate('https://other.example/');
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.handBack(handoffId);
    await handover.selectTab('t2');
    await handover.navigate('https://other.example/');
    expect(browser.navigate).toHaveBeenCalledTimes(2);
  });
});

describe('a window that closes on its own', () => {
  it('tells the app, so the card stops saying to finish in it', () => {
    const { handover } = setup();
    const listener = vi.fn();
    handover.useChangeListener(listener);
    handover.windowClosed();
    expect(listener).toHaveBeenCalledOnce();
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

  it('refuses a share with another chat, in any mode, while the person signs in', async () => {
    const { handover, browser } = panel();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    browser.open.mockClear();
    for (const mode of ['new-window', 'embedded'] as const)
      await expect(handover.open({ mode, sessionId: 'chat-2' })).rejects.toMatchObject({
        code: 'handoff_open',
      });
    expect(browser.open).not.toHaveBeenCalled();
    expect((await handover.state()).handoff?.outcome).toBeNull();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
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

describe('a handoff waiting on a profile (DOR-3887)', () => {
  it('keeps that profile from being deleted until the handoff ends', async () => {
    const { handover, set, setProfile } = setup();
    const key = randomBytes(32);
    const profiles = createLocalBrowserProfileStore(createTestDb(), () => key);
    const { id } = profiles.create('Example work');
    const folder = await prepareProfileFolder(dataDirectory, id);
    await writeFile(path.join(folder, 'storage-state.json'), 'made-up-site-session');
    // Wired as the service wires it: removal is busy while the handover holds the profile.
    const removal = new BrowserProfileRemoval({
      dataDirectory: () => dataDirectory,
      busy: (profileId) => handover.holdsProfile(profileId),
    });
    setProfile(id);
    const { handoffId } = await handover.ask('chat-1', 'wall');
    // The window has closed, so only the waiting handoff can hold the profile now.
    set({ ...connected(), status: 'disconnected', sessionId: null });
    handover.windowClosed();
    await expect(removal.delete(id, profiles)).rejects.toMatchObject({ code: 'profile_busy' });
    expect(profiles.get(id)).toBeDefined();
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
    // Once the person hands back, nothing holds it and the delete goes through.
    await handover.handBack(handoffId);
    await expect(removal.delete(id, profiles)).resolves.toBeUndefined();
    expect(profiles.get(id)).toBeUndefined();
  });
});
