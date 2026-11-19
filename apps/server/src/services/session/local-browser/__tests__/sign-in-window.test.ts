/** The sign-in window's states, with a fake Chromium. Nothing here launches a browser. */
import { describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PLAIN_FLAGS, type PlainChromiumExit } from '../plain-chromium.js';
import {
  SIGN_IN_QUIT_TIMEOUT_MS,
  SIGN_IN_SAVE_TIMEOUT_MS,
  SignInWindow,
} from '../sign-in-window.js';

function fakeChromium() {
  let exit!: (value: PlainChromiumExit) => void;
  const exited = new Promise<PlainChromiumExit>((resolve) => (exit = resolve));
  const quit = vi.fn(() => exit({ code: 0, signal: null }));
  const forceQuit = vi.fn(() => exit({ code: null, signal: 'SIGKILL' }));
  const spawner = vi.fn((_executable: string, _args: string[]) => ({
    pid: 4242,
    exited,
    quit,
    forceQuit,
  }));
  return { spawner, quit, forceQuit, exit };
}

function window(
  overrides: {
    held?: () => boolean;
    prepare?: () => Promise<void>;
    lockOwner?: () => number | undefined | 'unchecked';
    executable?: string;
    installedChrome?: string;
  } = {}
) {
  const chromium = fakeChromium();
  let clock = 0;
  const signIns = new SignInWindow({
    executable: async () => overrides.executable ?? '/managed/Chromium',
    installedChrome: () => overrides.installedChrome,
    spawner: chromium.spawner,
    held: overrides.held ?? (() => false),
    // The window the fake spawned holds the profile.
    lockOwner: overrides.lockOwner ?? (() => 4242),
    prepare: overrides.prepare ?? (async () => undefined),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { signIns, chromium };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SignInWindow', () => {
  it('opens a plain window, then saves once Chromium lets go of the profile', async () => {
    let held = true;
    let checks = 0;
    const { signIns, chromium } = window({
      held: () => {
        checks += 1;
        // Free before the window opens, held while it runs, free a moment after it closes.
        if (checks === 1) return false;
        if (checks > 3) held = false;
        return held;
      },
    });
    const opened = await signIns.start('/profiles/p1', 'p1', 'https://linear.app/');
    expect(opened).toMatchObject({ profileId: 'p1', site: 'linear.app', status: 'open' });
    expect(signIns.active).toBe(true);
    expect(signIns.holds('/profiles/p1')).toBe(true);
    const [executable, args] = chromium.spawner.mock.calls[0]!;
    expect(executable).toBe('/managed/Chromium');
    for (const flag of FORBIDDEN_PLAIN_FLAGS)
      expect(args.some((arg) => arg.startsWith(flag))).toBe(false);

    chromium.exit({ code: 0, signal: null });
    await settle();
    await settle();
    expect(signIns.current?.status).toBe('saved');
    expect(signIns.active).toBe(false);
  });

  // DOR-3876: only DorkOS's pinned test build says "only for automated testing" above the
  // password field, so only it hides info bars. The person's own Chrome keeps every bar.
  it('hides info bars on the pinned test build, never on installed Chrome', async () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const pinned = window({ installedChrome: chrome });
    await pinned.signIns.start('/profiles/p1', 'p1', 'https://linear.app/');
    expect(pinned.chromium.spawner.mock.calls[0]![1]).toContain('--disable-infobars');

    const none = window({ installedChrome: undefined });
    await none.signIns.start('/profiles/p1', 'p1', 'https://linear.app/');
    expect(none.chromium.spawner.mock.calls[0]![1]).toContain('--disable-infobars');

    const installed = window({ executable: chrome, installedChrome: chrome });
    await installed.signIns.start('/profiles/p1', 'p1', 'https://linear.app/');
    const [executable, args] = installed.chromium.spawner.mock.calls[0]!;
    expect(executable).toBe(chrome);
    expect(args).not.toContain('--disable-infobars');
  });

  it('turns password saving off before the window opens', async () => {
    const order: string[] = [];
    const chromium = fakeChromium();
    const signIns = new SignInWindow({
      executable: async () => '/managed/Chromium',
      spawner: (...args) => {
        order.push('spawn');
        return chromium.spawner(...args);
      },
      held: () => false,
      lockOwner: () => 4242,
      prepare: async () => void order.push('prepare'),
    });
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    expect(order).toEqual(['prepare', 'spawn']);
  });

  it('fails when the profile is never let go', async () => {
    let checks = 0;
    const { signIns, chromium } = window({ held: () => ++checks > 1 });
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    chromium.exit({ code: 0, signal: null });
    for (let i = 0; i < SIGN_IN_SAVE_TIMEOUT_MS / 200 + 5; i += 1) await settle();
    expect(signIns.current?.status).toBe('failed');
  });

  it('fails when Chromium never started', async () => {
    const { signIns, chromium } = window();
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    chromium.exit({ code: null, signal: null });
    await settle();
    expect(signIns.current?.status).toBe('failed');
  });

  it('never hands a sign-in to a Chromium it didn’t start', async () => {
    const { signIns, chromium } = window({ held: () => true });
    await expect(signIns.start('/profiles/p1', null, 'https://linear.app/')).rejects.toMatchObject({
      code: 'profile_busy',
    });
    expect(chromium.spawner).not.toHaveBeenCalled();
  });

  it('refuses when another Chromium took the profile between the check and the spawn', async () => {
    const { signIns, chromium } = window({ lockOwner: () => 999 });
    await expect(signIns.start('/profiles/p1', null, 'https://linear.app/')).rejects.toMatchObject({
      code: 'profile_busy',
    });
    expect(chromium.quit).toHaveBeenCalledOnce();
    await settle();
    await settle();
    expect(signIns.current?.status).toBe('failed');
    expect(signIns.active).toBe(false);
  });

  it('refuses when the window never takes hold of the profile', async () => {
    const { signIns } = window({ lockOwner: () => undefined });
    await expect(signIns.start('/profiles/p1', null, 'https://linear.app/')).rejects.toMatchObject({
      code: 'profile_busy',
    });
    expect(signIns.current?.status).toBe('failed');
  });

  it('allows one sign-in at a time', async () => {
    const { signIns } = window();
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    await expect(signIns.start('/profiles/p2', null, 'https://github.com/')).rejects.toMatchObject({
      code: 'signing_in',
    });
  });

  // DOR-4731: on a Mac, closing Chrome's last window leaves Chrome running, so its exit
  // never comes on its own. Done signing in quits the one Chromium this window started.
  it('finishes a sign-in whose window closed without Chromium quitting', async () => {
    const { signIns, chromium } = window();
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    for (let i = 0; i < 10; i += 1) await settle();
    expect(signIns.current?.status).toBe('open');
    signIns.done();
    expect(chromium.quit).toHaveBeenCalledOnce();
    expect(chromium.forceQuit).not.toHaveBeenCalled();
    await settle();
    await settle();
    expect(signIns.current?.status).toBe('saved');
    expect(signIns.active).toBe(false);
  });

  it('does nothing when Done is pressed on a sign-in that isn’t open', async () => {
    const none = window();
    none.signIns.done();
    expect(none.signIns.current).toBeNull();

    const { signIns, chromium } = window();
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    chromium.exit({ code: 0, signal: null });
    await settle();
    await settle();
    expect(signIns.current?.status).toBe('saved');
    chromium.quit.mockClear();
    signIns.done();
    expect(chromium.quit).not.toHaveBeenCalled();
    expect(signIns.current?.status).toBe('saved');
  });

  // Security (DOR-4731): fail at the deadline, then force that same child closed so its
  // profile lock clears for Try again. Nothing from a forced close is saved.
  it('on Linux and Windows, fails when Chromium ignores the quit, and forces it closed', async () => {
    let exitNow!: (value: PlainChromiumExit) => void;
    const exited = new Promise<PlainChromiumExit>((resolve) => (exitNow = resolve));
    // A Chromium that never answers the quit: only the forced close ends it.
    const quit = vi.fn();
    const forceQuit = vi.fn(() => exitNow({ code: null, signal: 'SIGKILL' }));
    let clock = 0;
    const signIns = new SignInWindow({
      platform: 'linux',
      executable: async () => '/managed/Chromium',
      spawner: () => ({ pid: 4242, exited, quit, forceQuit }),
      held: () => false,
      lockOwner: () => 4242,
      prepare: async () => undefined,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    signIns.done();
    for (let i = 0; i < SIGN_IN_QUIT_TIMEOUT_MS / 200 + 5; i += 1) await settle();
    expect(quit).toHaveBeenCalledOnce();
    expect(forceQuit).toHaveBeenCalledOnce();
    // The forced exit lands after the failure and must never be saved.
    for (let i = 0; i < 5; i += 1) await settle();
    expect(signIns.current?.status).toBe('failed');
    expect(signIns.active).toBe(false);
  });

  // DOR-4731: on a Mac a forced close loses the newest cookies too, so it never comes. The
  // window stays open, holding its profile, and the person is asked to quit it with ⌘Q.
  it('on a Mac, never forces a window that ignores the quit; it asks for ⌘Q and still saves', async () => {
    let exitNow!: (value: PlainChromiumExit) => void;
    const exited = new Promise<PlainChromiumExit>((resolve) => (exitNow = resolve));
    const quit = vi.fn();
    const forceQuit = vi.fn();
    let clock = 0;
    let held = false;
    const signIns = new SignInWindow({
      platform: 'darwin',
      executable: async () => '/managed/Chromium',
      spawner: () => ({ pid: 4242, exited, quit, forceQuit }),
      held: () => held,
      lockOwner: () => 4242,
      prepare: async () => undefined,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    held = true;
    signIns.done();
    for (let i = 0; i < SIGN_IN_QUIT_TIMEOUT_MS / 200 + 5; i += 1) await settle();
    expect(forceQuit).not.toHaveBeenCalled();
    expect(signIns.current).toMatchObject({ status: 'open', needsQuit: true });
    // Its profile stays held, so nothing else may take it meanwhile.
    expect(signIns.holds('/profiles/p1')).toBe(true);
    // The person quits it with ⌘Q: Chromium exits cleanly, lets go, and the sign-in saves.
    held = false;
    exitNow({ code: 0, signal: null });
    for (let i = 0; i < 5; i += 1) await settle();
    expect(signIns.current?.status).toBe('saved');
    expect(signIns.current?.needsQuit).toBeUndefined();
  });

  it('says so each time the status moves, and the status has moved by then', async () => {
    const { signIns, chromium } = window();
    const seen: Array<string | undefined> = [];
    signIns.onChange(() => seen.push(signIns.current?.status));
    await signIns.start('/profiles/a', null, 'https://example.com/');
    expect(seen).toEqual(['open']);
    chromium.exit({ code: 0, signal: null });
    await settle();
    expect(seen).toEqual(['open', 'saving', 'saved']);
  });

  it('says so when the window can’t open', async () => {
    const { signIns } = window({
      prepare: async () => {
        throw new Error('disk');
      },
    });
    const seen: Array<string | undefined> = [];
    signIns.onChange(() => seen.push(signIns.current?.status));
    await expect(signIns.start('/profiles/a', null, 'https://example.com/')).rejects.toThrow();
    expect(seen).toEqual(['open', 'failed']);
  });
});
