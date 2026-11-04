/** The sign-in window's states, with a fake Chromium. Nothing here launches a browser. */
import { describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PLAIN_FLAGS, type PlainChromiumExit } from '../plain-chromium.js';
import { SIGN_IN_SAVE_TIMEOUT_MS, SignInWindow } from '../sign-in-window.js';

function fakeChromium() {
  let exit!: (value: PlainChromiumExit) => void;
  const exited = new Promise<PlainChromiumExit>((resolve) => (exit = resolve));
  const quit = vi.fn(() => exit({ code: 0, signal: null }));
  const spawner = vi.fn((_executable: string, _args: string[]) => ({ pid: 4242, exited, quit }));
  return { spawner, quit, exit };
}

function window(
  overrides: {
    held?: () => boolean;
    prepare?: () => Promise<void>;
    lockOwner?: () => number | undefined | 'unchecked';
  } = {}
) {
  const chromium = fakeChromium();
  let clock = 0;
  const signIns = new SignInWindow({
    executable: async () => '/managed/Chromium',
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

  it('closes an open window the way a person would', async () => {
    const { signIns, chromium } = window();
    await signIns.start('/profiles/p1', null, 'https://linear.app/');
    signIns.close();
    expect(chromium.quit).toHaveBeenCalledOnce();
    await settle();
    await settle();
    expect(signIns.current?.status).toBe('saved');
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
