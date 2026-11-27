/** Asking a person to take the browser, their answers and controls, and what the app hears. */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// A launch reads the rooms folder through the agent facts port, wired as boot does.
import '../../../../core/agent-identity/__tests__/wire-test-facts.js';
import { BrowserHandover, assertSignInUrl } from '../../handover.js';
import { HANDED_BACK_MESSAGE, handBackWake } from '../../hand-back-wake/index.js';
import { handBackWakeHarness } from '../hand-back-wake-harness.js';
import type { SignInWindow } from '../../sign-in-window.js';
import { dataDirectory, connected, fakeBrowser, fakeSignIns, setup } from './handover.fixtures.js';

describe('detached handoffs', () => {
  it.each(['url', 'tab', 'profile', 'connection', 'session'] as const)(
    'refuses a changed %s after the pause without opening a sign-in window',
    async (move) => {
      const f = setup(false, 'new-window');
      f.browser.handToPerson.mockImplementationOnce(async () => {
        const next = { ...connected(), paused: true };
        if (move === 'url') next.tabs = [{ ...next.tabs[0]!, url: 'https://other.example/' }];
        if (move === 'tab') {
          next.selectedTabId = 't2';
          next.tabs = [{ ...next.tabs[0]!, id: 't2' }];
        }
        if (move === 'profile') f.setProfile('p2');
        if (move === 'connection') next.connectionId = 'c2';
        if (move === 'session') next.sessionId = 'chat-2';
        return f.set(next);
      });
      await expect(f.handover.ask('chat-1', 'wall')).rejects.toMatchObject({
        code: 'site_changed',
      });
      expect(f.signIns.start).not.toHaveBeenCalled();
      expect(f.browser.resume).not.toHaveBeenCalled();
      expect(await f.handover.state()).toMatchObject({ paused: true, handoff: null });
    }
  );

  it.each(['password'] as const)(
    'closes the automated window before opening the plain %s handoff at the same page',
    async (reason) => {
      const { handover, browser, signIns } = setup(false, 'new-window');
      await handover.ask('chat-1', reason);
      expect(browser.disconnect).toHaveBeenCalledOnce();
      expect(signIns.start).toHaveBeenCalledWith(
        path.join(dataDirectory, 'browser-profiles', 'p1'),
        'p1',
        connected().tabs[0]!.url,
        expect.objectContaining({
          require: expect.any(Function),
          assertCurrent: expect.any(Function),
        })
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
    expect(signIns.done).not.toHaveBeenCalled();
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
    expect(signIns.done).not.toHaveBeenCalled();
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
});

describe('BrowserHandover sign-in', () => {
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

  it('blocks the agent on its profile while a person signs in there', async () => {
    const { handover } = setup();
    await handover.signIn({
      url: 'https://linear.app/',
      profileId: '00000000-0000-4000-8000-000000000001',
    });
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
    const other = setup();
    other.setProfile(null);
    await other.handover.signIn({ url: 'https://linear.app/' });
    await expect(other.handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'signing_in',
    });
  });

  it('won’t open a profile a sign-in holds', async () => {
    const { handover, browser } = setup();
    browser.open.mockClear();
    await handover.signIn({ url: 'https://linear.app/' });
    await expect(
      handover.open({ mode: 'new-window', sessionId: 'chat-1', profileId: 'p1' })
    ).rejects.toMatchObject({
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

  it('refuses an answer to a handoff that already ended', async () => {
    const { handover } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    await handover.stop(handoffId);
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'handoff_ended' });
    await expect(handover.stop('someone-else')).rejects.toMatchObject({ code: 'handoff_ended' });
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

  it('refuses Back and Forward during a handoff, and passes them through once it ends', async () => {
    const { handover, browser } = setup();
    const { handoffId } = await handover.ask('chat-1', 'wall');
    for (const direction of ['back', 'forward'] as const)
      await expect(handover.stepHistory(direction)).rejects.toMatchObject({
        code: 'handoff_open',
      });
    expect(browser.stepHistory).not.toHaveBeenCalled();
    await handover.handBack(handoffId);
    await handover.stepHistory('back');
    expect(browser.stepHistory).toHaveBeenCalledExactlyOnceWith('back');
    // Like the address bar, Back took the page from the agent it was handed back to.
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
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
    handover.useOutsideTurnCheck(async () => null);
    const changed = vi.fn();
    handover.useChangeListener(changed);
    const handedOver = vi.fn();
    handover.useHandoffListener(handedOver);
    return { handover, signIns, changed, handedOver };
  }

  it('says so when a handoff starts, once, and not on a repeat ask', async () => {
    const { handover, changed } = wired();
    await handover.ask('chat-1', 'wall');
    expect(changed).toHaveBeenCalledTimes(1);
    await handover.ask('chat-1', 'wall');
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
