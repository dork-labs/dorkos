/** Signing in during a handoff: embedded and named profiles, a person taking the page, refused sites, and Done signing in. */
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { BrowserProfileRemoval } from '../../profile-removal/index.js';
import { prepareProfileFolder } from '../../profile-folders.js';
import { createLocalBrowserProfileStore } from '../../profile-store.js';
import { dataDirectory, connected, setup } from './handover.fixtures.js';
import { LocalBrowserAskPersonSchema } from '@dorkos/shared/local-browser';
import { SIGNING_IN_REFUSAL } from '../../handover.js';

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

describe('a person takes the page (DOR-4428)', () => {
  it('pauses the sharing chat and refuses its reads until a person resumes', async () => {
    const { handover, browser } = setup();
    const changed = vi.fn();
    handover.useChangeListener(changed);
    const taken = await handover.takeOver();
    expect(taken.takenOver).toBe(true);
    expect(browser.pause).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalled();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
    // The agent can't hand the page back to itself by asking for a person.
    await expect(handover.ask('chat-1', 'wall')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
    const resumed = await handover.resume();
    expect(resumed.takenOver).toBe(false);
    expect(browser.resume).toHaveBeenCalledOnce();
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('refuses the agent from the moment the take-over starts, before the pause lands', async () => {
    const { handover, browser } = setup();
    let release!: () => void;
    browser.pause.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...connected(), paused: true });
        })
    );
    const taking = handover.takeOver();
    await vi.waitFor(() => expect(browser.pause).toHaveBeenCalled());
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
    release();
    await taking;
  });

  it('takes the page first when the person navigates, in the same call', async () => {
    const { handover, browser } = setup();
    const next = await handover.navigate('https://northwind.example/pricing');
    expect(next.takenOver).toBe(true);
    expect(browser.pause.mock.invocationCallOrder[0]).toBeLessThan(
      browser.navigate.mock.invocationCallOrder[0]!
    );
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
  });

  it('keeps the agent shut out when the navigate and its http try both fail', async () => {
    const { handover, browser } = setup();
    browser.navigate.mockRejectedValueOnce(
      Object.assign(new Error('Couldn’t reach that site.'), { code: 'navigation_unreachable' })
    );
    await expect(
      handover.navigate('https://shop.example/', { httpFallback: true })
    ).rejects.toMatchObject({ code: 'navigation_unreachable' });
    expect(browser.pause).toHaveBeenCalled();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
  });

  it('keeps the agent shut out when Back itself is refused', async () => {
    const { handover, browser } = setup();
    browser.stepHistory.mockRejectedValueOnce(new Error('no page to go back to'));
    await expect(handover.stepHistory('back')).rejects.toThrow();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'taken_by_person',
    });
    expect((await handover.state()).takenOver).toBe(true);
  });

  it.each(['disconnect', 'open'] as const)('gives the page back on %s', async (how) => {
    const { handover } = setup();
    await handover.takeOver();
    const next =
      how === 'disconnect'
        ? await handover.disconnect()
        : await handover.open({ mode: 'embedded', sessionId: 'chat-1' });
    expect(next.takenOver).toBe(false);
  });
});

// DOR-4097 (c): a site that refuses the in-app browser goes on in its own window. The
// person signs in in the plain window on the same default profile, and Hand back
// opens the site in its own window, where that sign-in is.
describe('continuing a refused in-app handoff in its own window (DOR-4097)', () => {
  it('signs in in the plain window, then hands back into its own window on that page', async () => {
    const { handover, browser, signIns, setProfile, finish } = setup();
    setProfile(null);
    const asked = 'https://accounts.example.com/login?next=%2Fhome';
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.open({ mode: 'new-window', sessionId: 'chat-1' });
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(signIns.start).toHaveBeenCalledWith(
      path.join(dataDirectory, 'browser-profiles', 'default'),
      null,
      asked
    );
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'signing_in' });
    finish('saved');
    await handover.handBack(handoffId);
    expect(browser.open).toHaveBeenLastCalledWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      url: asked,
    });
    expect((await handover.state()).handoff?.outcome).toBe('handed-back');
  });

  it('keeps every agent out until the person hands back', async () => {
    const { handover, finish } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.open({ mode: 'new-window', sessionId: 'chat-1' });
    finish('saved');
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'handed_to_person',
    });
    await handover.handBack(handoffId);
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });
});

// DOR-4097: the card offers the sign-in window only when DorkOS's own last reading of
// that same site was a refusal. The agent's words can't set it.
describe('a handoff on a refused site (DOR-4097)', () => {
  it('marks the handoff refused from the server’s own reading of the same site', async () => {
    const { handover, browser } = setup();
    const lastRefusalHost = vi.fn(() => 'accounts.example.com');
    Object.assign(browser, { lastRefusalHost });
    const order: string[] = [];
    lastRefusalHost.mockImplementation(() => (order.push('read'), 'accounts.example.com'));
    browser.handToPerson.mockImplementationOnce(async () => {
      order.push('hand');
      return { ...connected(), mode: 'embedded' as const, paused: true };
    });
    await handover.ask('chat-1', 'password');
    expect((await handover.state()).handoff?.refused).toBe(true);
    // Handing over clears the reading, so it is read first.
    expect(order).toEqual(['read', 'hand']);
  });

  it('refuses an agent’s own claim that the site refused it', () => {
    expect(
      LocalBrowserAskPersonSchema.safeParse({ reason: 'password', refused: true }).success
    ).toBe(false);
  });
});

// DOR-4693 part B: "Sign in in its own window" on a refused page closes the agent's own window on
// that profile, then puts it back when the sign-in ends; never while the person is using it.
describe('a sign-in started from a refused page', () => {
  /** A chat's own-window Agent browser on the default profile, with the change listener wired. */
  function ownWindow() {
    const made = setup(false, 'new-window');
    made.setProfile(null);
    made.handover.useChangeListener(vi.fn());
    const signInMoved = () => made.signIns.onChange.mock.calls.at(-1)![0]();
    return { ...made, signInMoved };
  }

  it.each(['saved'] as const)(
    'reopens the chat’s window at the page DorkOS read, once the sign-in has %s',
    async (ending) => {
      const { handover, browser, finish, signInMoved } = ownWindow();
      await handover.signIn({ url: 'https://accounts.example.com/' });
      expect(browser.disconnect).toHaveBeenCalledOnce();
      expect(browser.open).not.toHaveBeenCalled();
      finish(ending);
      signInMoved();
      await vi.waitFor(() => expect(browser.open).toHaveBeenCalledOnce());
      expect(browser.open).toHaveBeenCalledWith({
        mode: 'new-window',
        sessionId: 'chat-1',
        url: 'https://accounts.example.com/login?next=%2Fhome',
      });
    }
  );

  // Security's condition: an own-window browser in a handoff is the person's. Never close it.
  it('refuses, and closes nothing, while a handoff is open in the agent’s own window', async () => {
    const { handover, browser, set, signIns } = ownWindow();
    await handover.ask('chat-1', 'password');
    browser.disconnect.mockClear();
    signIns.start.mockClear();
    set(connected());
    await expect(handover.signIn({ url: 'https://accounts.example.com/' })).rejects.toMatchObject({
      code: 'browser_in_use',
    });
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect(signIns.start).not.toHaveBeenCalled();
  });
});

// DOR-4731: on a Mac, closing Chrome's last window leaves Chrome running, so DorkOS never
// sees the close and the sign-in stays open. Done signing in must still finish it.
describe('Done signing in (DOR-4731)', () => {
  it('finishes when the window closed, the close was missed, and the person presses Done', async () => {
    const { handover, browser, signIns } = setup(false, 'new-window');
    const ended = vi.fn();
    handover.useEndListener(ended);
    const { handoffId } = await handover.ask('chat-1', 'password');
    // The close never reached DorkOS: the window still reads as open, and Continue can't help.
    expect((await handover.state()).signIn?.status).toBe('open');
    await expect(handover.handBack(handoffId)).rejects.toMatchObject({ code: 'signing_in' });

    await handover.finishSignIn(handoffId);

    expect(signIns.done).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
    expect(ended.mock.calls[0]![0]).toMatchObject({ id: handoffId, outcome: 'handed-back' });
    expect(browser.open).toHaveBeenCalledWith({
      mode: 'new-window',
      sessionId: 'chat-1',
      profileId: 'p1',
      url: connected().tabs[0]!.url,
    });
    await expect(handover.requireAgentMayUse('chat-1')).resolves.toBeUndefined();
  });

  it('keeps the handoff open with the failure showing when the save fails', async () => {
    const { handover, browser, doneLandsAs } = setup(false, 'new-window');
    const ended = vi.fn();
    handover.useEndListener(ended);
    const { handoffId } = await handover.ask('chat-1', 'password');
    doneLandsAs('failed');

    await handover.finishSignIn(handoffId);

    const state = await handover.state();
    expect(state.signIn?.status).toBe('failed');
    expect(state.handoff).toMatchObject({ id: handoffId, outcome: null });
    expect(ended).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('refuses Done for a handoff that already ended', async () => {
    const { handover, signIns } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.stop(handoffId);
    await expect(handover.finishSignIn(handoffId)).rejects.toMatchObject({
      code: 'handoff_ended',
    });
    expect(signIns.done).not.toHaveBeenCalled();
  });

  // Security (DOR-4731): Stop leaves the window for the person (2FA, a payment), so the
  // panel's Done signing in must still end it, free the browser, and never resume the agent.
  it('after Stop, Done signing in saves and frees the browser without resuming the agent', async () => {
    const { handover, browser, signIns } = setup(false, 'new-window');
    const ended = vi.fn();
    handover.useEndListener(ended);
    const { handoffId } = await handover.ask('chat-1', 'password');
    await handover.stop(handoffId);
    expect(signIns.done).not.toHaveBeenCalled();
    // The 409s that followed Stop in the reported case.
    const reopen = { mode: 'new-window' as const, sessionId: 'chat-1', profileId: 'p1' };
    await expect(handover.open(reopen)).rejects.toMatchObject({ code: 'signing_in' });
    // Another agent is told why, in plain words, never a bare busy.
    await expect(handover.ask('chat-2', 'password')).rejects.toMatchObject({
      code: 'signing_in',
      message: SIGNING_IN_REFUSAL,
    });

    await handover.finishSignIn();

    expect(signIns.done).toHaveBeenCalledOnce();
    expect((await handover.state()).signIn?.status).toBe('saved');
    expect(ended).toHaveBeenCalledOnce();
    expect(ended.mock.calls[0]![0]).toMatchObject({ outcome: 'stopped' });
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.resume).not.toHaveBeenCalled();
    await expect(handover.requireAgentMayUse('chat-1')).rejects.toMatchObject({
      code: 'task_stopped',
    });
    await handover.open(reopen);
    expect(browser.open).toHaveBeenCalledWith(reopen);
  });

  it('refuses a Done that names no handoff while one is open', async () => {
    const { handover, signIns } = setup(false, 'new-window');
    await handover.ask('chat-1', 'password');
    await expect(handover.finishSignIn()).rejects.toMatchObject({ code: 'handoff_open' });
    expect(signIns.done).not.toHaveBeenCalled();
  });

  it('refuses Done for a sign-in that isn’t this handoff’s', async () => {
    const { handover, signIns, signInSite } = setup(false, 'new-window');
    const { handoffId } = await handover.ask('chat-1', 'password');
    signInSite('elsewhere.example');
    await expect(handover.finishSignIn(handoffId)).rejects.toMatchObject({ code: 'signing_in' });
    expect(signIns.done).not.toHaveBeenCalled();
  });

  it('refuses Done when the handoff has no sign-in window', async () => {
    const { handover, signIns } = setup();
    const { handoffId } = await handover.ask('chat-1', 'password');
    await expect(handover.finishSignIn(handoffId)).rejects.toMatchObject({
      code: 'sign_in_failed',
    });
    expect(signIns.done).not.toHaveBeenCalled();
  });
});
