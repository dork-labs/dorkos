/** Handing the browser to a person and back, with a fake browser and a fake sign-in window. */
import { dataDirectory, connected, fakeBrowser, fakeSignIns, setup } from './handover-fixture.js';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../../lib/logger.js';
import { BrowserHandover, assertSignInUrl } from '../handover.js';
import { HANDED_BACK_MESSAGE, handBackWake } from '../hand-back-wake/index.js';

import { handBackWakeHarness } from './hand-back-wake-harness.js';
import { BrowserProfileRemoval } from '../profile-removal/index.js';
import { prepareProfileFolder } from '../profile-folders.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';
import type { SignInWindow } from '../sign-in-window.js';

describe('detached handoffs', () => {
  it('serializes hand-back against a second answer or reopen', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    const ended = vi.fn();
    handover.useEndListener(ended);
    let release!: () => void;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    browser.resume.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...connected(), paused: false as const };
    });
    const handingBack = handover.handBack(handoffId);
    await starting;
    try {
      await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'busy' });
      await expect(handover.stop(handoffId)).rejects.toMatchObject({ code: 'busy' });
      await expect(handover.open({ mode: 'embedded', sessionId: 'chat-1' })).rejects.toMatchObject({
        code: 'busy',
      });
    } finally {
      release();
    }
    await handingBack;
    expect(browser.resume).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });
  it.each(['wall', 'password'] as const)(
    'closes the automated window before opening the plain %s handoff at the same page',
    async (reason) => {
      const { handover, browser, signIns } = setup(false, 'new-window');
      await handover.ask('chat-1', reason);
      expect(browser.disconnect).toHaveBeenCalledOnce();
      expect(signIns.start).toHaveBeenCalledWith(
        path.join(dataDirectory, 'browser-profiles', 'p1'),
        'p1',
        connected().tabs[0]!.url
      );
      expect(browser.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        signIns.start.mock.invocationCallOrder[0]!
      );
    }
  );
  it('keeps Stop detached without reopening the agent window', async () => {
    const { handover, browser, signIns } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.stop(handoffId);
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(browser.open).not.toHaveBeenCalled();
    expect(signIns.close).not.toHaveBeenCalled();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'task_stopped',
    });
  });
  it('reopens on the same profile and page only after the person closes the plain window', async () => {
    const { handover, browser, finish } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'signing_in' });
    expect(browser.open).not.toHaveBeenCalled();
    finish('saved');
    await handover.handBack(handoffId);
    expect(browser.open).toHaveBeenCalledWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      profileId: 'p1',
      url: connected().tabs[0]!.url,
    });
  });
});

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

describe('the person’s state during a handoff (DOR-4163)', () => {
  const secret = 'https://accounts.example.com/callback?code=secret#token=x';

  it('shows each tab’s site only while a person has the browser', async () => {
    const { handover, set } = setup();
    // Embedded keeps the agent's own page through the handoff; a separate window would
    // close it for the person's plain window, and hand-back would wait for that window.
    set({
      ...connected(secret),
      mode: 'embedded',
      tabs: [
        { id: 't1', url: secret, title: 'Reset code 492810 for sam@example.com' },
        { id: 't2', url: 'https://mail.example/inbox/42?q=x', title: 'Inbox' },
        { id: 't3', url: 'about:blank', title: '' },
        { id: 't4', url: 'data:text/html,secret', title: '' },
      ],
    });
    expect((await handover.state()).tabs[0]!.url).toBe(secret);
    const { handoffId } = await handover.ask('chat-1', 'wall');
    const during = await handover.state();
    expect(during.tabs.map((tab) => tab.url)).toEqual([
      'https://accounts.example.com',
      'https://mail.example',
      'about:blank',
      'data:',
    ]);
    expect(during.tabs.map((tab) => tab.title)).toEqual(['', '', '', '']);
    expect(JSON.stringify(during)).not.toMatch(/secret|token=|code=|inbox\/42|492810|sam@|Inbox/);
    // The card still names the site the agent asked on.
    expect(during.handoff?.site).toBe('accounts.example.com');
    await handover.handBack(handoffId);
    const after = await handover.state();
    expect(after.tabs[0]).toMatchObject({
      url: secret,
      title: 'Reset code 492810 for sam@example.com',
    });
  });

  it('answers a person’s Pause and tab choice with the same trimmed tabs', async () => {
    const { handover, set } = setup();
    set({ ...connected(secret), tabs: [{ id: 't1', url: secret, title: 'Code 492810' }] });
    await handover.ask('chat-1', 'wall');
    for (const answer of [await handover.pause(), await handover.selectTab('t1')]) {
      expect(answer.tabs).toEqual([{ id: 't1', url: 'https://accounts.example.com', title: '' }]);
      expect(JSON.stringify(answer)).not.toMatch(/secret|token=|code=|492810/);
    }
  });

  it('shows the full address again once the person stops the task', async () => {
    const { handover, set } = setup();
    set(connected(secret));
    await handover.stop((await handover.ask('chat-1', 'wall')).handoffId);
    expect((await handover.state()).tabs[0]!.url).toBe(secret);
  });
});

describe('BrowserHandover.ask', () => {
  it('keeps a pending handoff pending when Pause is pressed (DOR-4135)', async () => {
    const { handover, browser, signIns } = setup();
    const ended = vi.fn();
    handover.useEndListener(ended);
    const { handoffId } = await handover.ask('chat-1', 'password');
    const pending = structuredClone((await handover.state()).handoff);
    expect(pending).toMatchObject({ id: handoffId, outcome: null });
    browser.resume.mockClear();
    browser.disconnect.mockClear();

    const paused = await handover.pause();

    expect(paused.paused).toBe(true);
    expect((await handover.state()).handoff).toEqual(pending);
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
    expect(browser.resume).not.toHaveBeenCalled();
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect(signIns.close).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();

    // Only the person's answer ends this same handoff.
    const returned = await handover.handBack(handoffId);
    expect(returned.handoff).toMatchObject({ id: handoffId, outcome: 'handed-back' });
    expect(ended).toHaveBeenCalledOnce();
    expect(browser.resume).toHaveBeenCalledOnce();
  });

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
    expect(browser.handToPerson).toHaveBeenCalledOnce();
    expect(browser.selectTab).toHaveBeenCalledWith('t1', 'chat-1');
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
      mode: 'embedded',
      tabs: [
        {
          id: 't1',
          url: 'https://accounts.example.com/login?next=%2Fbilling&token=made-up',
          title: 'Made-up Shop: verify you are human',
        },
      ],
    });
    const harness = await handBackWakeHarness(dataDirectory, 'chat-1');
    try {
      s.handover.useEndListener(
        handBackWake({ meshCore: () => undefined, roomSessionPlace: () => undefined })
      );
      const { handoffId } = await s.handover.ask('chat-1', 'wall');
      await s.handover.handBack(handoffId);
      await vi.waitFor(() => expect(harness.runtime.sendMessage).toHaveBeenCalledOnce());
      const [sessionId, content, opts] = harness.runtime.sendMessage.mock.calls[0]!;
      expect(sessionId).toBe('chat-1');
      expect(content).toBe(HANDED_BACK_MESSAGE);
      expect(opts?.turnStarter).toBe('person');
      const sent = JSON.stringify({ content, opts });
      for (const fromPage of ['accounts.example.com', '/login', 'made-up', 'verify you are human'])
        expect(sent).not.toContain(fromPage);
    } finally {
      await harness.dispose();
    }
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
  it('reuses the plain window already opened by the handoff', async () => {
    const { handover, signIns } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    expect(signIns.start).toHaveBeenCalledOnce();
    expect(signIns.start.mock.calls[0]![2]).toBe(connected().tabs[0]!.url);
  });

  it('refuses a plain handoff on an http page off this computer', async () => {
    const { handover, set, signIns } = setup(false, 'new-window');
    set(connected('http://shop.example/'));
    await expect(handover.ask('chat-1', 'password')).rejects.toMatchObject({
      code: 'unsupported_address',
    });
    expect(signIns.start).not.toHaveBeenCalled();
  });

  it('keeps the agent out and Hand back closed until the sign-in is saved', async () => {
    const { handover, finish } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'signing_in' });
    finish('saved');
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('reopens the agent window for the same chat and page on Hand back', async () => {
    const { handover, browser, finish } = setup(false, 'new-window');
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

  it('a closed window reopens plainly at the saved page, with the agent still out', async () => {
    const { handover, browser, signIns, set } = setup();
    await handover.ask('chat-1', 'wall');
    set({ ...connected(), status: 'closed', tabs: [], selectedTabId: null });
    await handover.open({ mode: 'new-window', sessionId: 'chat-1', url: 'https://other.test/' });
    expect(browser.open).not.toHaveBeenCalled();
    expect(signIns.start).toHaveBeenCalledWith(
      path.join(dataDirectory, 'browser-profiles', 'p1'),
      'p1',
      connected().tabs[0]!.url
    );
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
    expect(browser.selectTab).toHaveBeenCalledExactlyOnceWith('t1', undefined);
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
  function wired(state = { ...connected(), mode: 'embedded' as const }) {
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

describe('signing in from the detached embedded browser', () => {
  it('keeps the same view and opens no plain process', async () => {
    const { handover, browser, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    expect(browser.handToPerson).toHaveBeenCalled();
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect(signIns.start).not.toHaveBeenCalled();
    await handover.handBack(handoffId);
    expect(browser.resume).toHaveBeenCalledOnce();
    expect(browser.open).not.toHaveBeenCalled();
  });
  it('publishes no handoff if detaching the view fails', async () => {
    const { handover, browser, signIns } = setup();
    browser.handToPerson.mockRejectedValueOnce(new Error('could not detach'));
    await expect(handover.ask('chat-1', 'password')).rejects.toThrow('could not detach');
    expect((await handover.state()).handoff).toBeNull();
    expect(signIns.start).not.toHaveBeenCalled();
  });
  it('keeps every agent out until hand-back, including while signing in', async () => {
    const { handover } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.signIn({ handoffId });
    for (const chat of ['chat-1', 'chat-2'])
      await expect(handover.requireAgentMayUse(chat)).rejects.toMatchObject({
        code: 'handed_to_person',
      });
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });
  it('leaves the handoff open when reattaching fails', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    browser.resume.mockRejectedValueOnce(new Error('cannot reattach'));
    await expect(handover.handBack(handoffId)).rejects.toThrow('cannot reattach');
    expect((await handover.state()).handoff?.outcome).toBeNull();
  });
  it('needs no separate window for an embedded sign-in', async () => {
    const { handover, browser } = setup();
    browser.capabilities.mockReturnValue({ newWindow: false });
    const { handoffId } = await handover.ask('chat-1', 'password');
    await expect(handover.signIn({ handoffId })).resolves.toBeDefined();
    expect(browser.disconnect).not.toHaveBeenCalled();
  });
});

// DOR-4180: a sign-in on a profile that's gone would make its folder again, and the
// sign-in would land in a profile nobody can see or delete.
describe('a sign-in on a profile that no longer exists (DOR-4180)', () => {
  async function deletedProfile() {
    const run = setup();
    const key = randomBytes(32);
    const profiles = createLocalBrowserProfileStore(createTestDb(), () => key);
    run.browser.profileExists.mockImplementation((id) => profiles.get(id) !== undefined);
    const { id } = profiles.create('Example work');
    await prepareProfileFolder(dataDirectory, id);
    const removal = new BrowserProfileRemoval({
      dataDirectory: () => dataDirectory,
      busy: (profileId) => run.handover.holdsProfile(profileId),
    });
    await removal.delete(id, profiles);
    return { ...run, id, folder: path.join(dataDirectory, 'browser-profiles', id) };
  }

  it('refuses a person’s sign-in on a deleted profile, and makes no folder', async () => {
    const { handover, signIns, id, folder } = await deletedProfile();
    expect(existsSync(folder)).toBe(false);
    await expect(
      handover.signIn({ url: 'https://linear.app/', profileId: id })
    ).rejects.toMatchObject({ code: 'profile_not_found' });
    expect(existsSync(folder)).toBe(false);
    expect(signIns.start).not.toHaveBeenCalled();
  });

  it('refuses a profile id it never knew', async () => {
    const { handover, signIns } = await deletedProfile();
    const unknown = '00000000-0000-4000-8000-00000000abcd';
    await expect(
      handover.signIn({ url: 'https://linear.app/', profileId: unknown })
    ).rejects.toMatchObject({ code: 'profile_not_found' });
    expect(existsSync(path.join(dataDirectory, 'browser-profiles', unknown))).toBe(false);
    expect(signIns.start).not.toHaveBeenCalled();
  });

  it('refuses a handoff’s sign-in when the agent’s profile is gone', async () => {
    const { handover, browser, signIns, setProfile, id, folder } = await deletedProfile();
    setProfile(id);
    const { handoffId } = await handover.ask('chat-1', 'password');
    await expect(handover.signIn({ handoffId })).rejects.toMatchObject({
      code: 'profile_not_found',
    });
    expect(existsSync(folder)).toBe(false);
    expect(signIns.start).not.toHaveBeenCalled();
    expect(browser.disconnect).not.toHaveBeenCalled();
  });

  it('refuses reopening a handoff’s saved page on a profile deleted since it asked', async () => {
    const run = setup(false, 'new-window');
    const { handoffId } = await run.handover.ask('chat-1', 'password');
    // The person's first window ended; Sign in again opens a new one at the saved page.
    run.finish('failed');
    run.signIns.start.mockClear();
    // The agent's window is gone, so only the saved page still names the profile.
    run.setProfile(null);
    run.browser.profileExists.mockReturnValue(false);
    const folder = path.join(dataDirectory, 'browser-profiles', 'p1');
    rmSync(folder, { recursive: true, force: true });
    await expect(run.handover.signIn({ handoffId })).rejects.toMatchObject({
      code: 'profile_not_found',
    });
    expect(run.signIns.start).not.toHaveBeenCalled();
    expect(existsSync(folder)).toBe(false);
  });

  it('still signs in on the default profile, which has no id', async () => {
    const { handover, signIns } = await deletedProfile();
    await handover.signIn({ url: 'https://linear.app/' });
    expect(signIns.start).toHaveBeenCalledOnce();
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

it('keeps embedded handoff lifecycle recovery unchanged', async () => {
  const { handover } = setup();
  const { handoffId } = await handover.ask('chat-1', 'password');
  await handover.handBack(handoffId);
  await handover.chatEnded('chat-1');
  await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
});
