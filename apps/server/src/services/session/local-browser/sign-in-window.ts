/** One plain sign-in window at a time, and whether its sign-in reached the disk. */
import type { LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from './errors.js';
import { managedChromiumPath } from './playwright-backend.js';
import {
  disablePasswordSaving,
  forgetOpenTabs,
  plainChromiumArgs,
  profileHeld,
  profileLockPid,
  spawnPlainChromium,
  type PlainChromium,
  type PlainChromiumSpawner,
} from './plain-chromium.js';

/** How long Chromium may take to let go of the profile after its window closes. */
export const SIGN_IN_SAVE_TIMEOUT_MS = 20_000;
const SAVE_POLL_MS = 200;
/** How long a new window may take to take hold of its profile. */
export const SIGN_IN_LOCK_TIMEOUT_MS = 5_000;

/** No saved passwords, and none of the tabs an agent left open: only a person is here. */
async function preparePlainProfile(profileFolder: string): Promise<void> {
  await disablePasswordSaving(profileFolder);
  await forgetOpenTabs(profileFolder);
}

/** The pid holding a profile, or `unchecked` where the lock names none (Windows). */
type LockOwner = (profileFolder: string) => number | undefined | 'unchecked';
const lockOwnerHere: LockOwner = (folder) =>
  process.platform === 'win32' ? 'unchecked' : profileLockPid(folder);

/** The machine pieces a sign-in window uses, swapped for fakes in tests. */
export interface SignInWindowDeps {
  /** The managed Chromium's path, downloading it first if needed. */
  executable?: () => Promise<string>;
  spawner?: PlainChromiumSpawner;
  /** Whether a Chromium still holds the profile folder. */
  held?: (profileFolder: string) => boolean;
  /** Which process holds a profile, read after the window starts. */
  lockOwner?: LockOwner;
  /** Get the profile ready: password saving off, no tabs to bring back. */
  prepare?: (profileFolder: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The person's sign-in window. It has no debugging channel, so nothing here
 * can read the page: DorkOS only knows the window opened and later closed.
 */
export class SignInWindow {
  private record: LocalBrowserSignIn | null = null;
  private window?: PlainChromium;
  private folder?: string;
  private attempt = 0;

  constructor(private readonly deps: SignInWindowDeps = {}) {}

  /** The latest sign-in, or null when none has started since the server did. */
  get current(): LocalBrowserSignIn | null {
    return this.record;
  }

  /** Whether a window is open or its sign-in is still being saved. */
  get active(): boolean {
    return this.record?.status === 'open' || this.record?.status === 'saving';
  }

  /** Whether an open or saving window holds this profile folder. */
  holds(profileFolder: string): boolean {
    return this.active && this.folder === profileFolder;
  }

  /**
   * Open the window and follow it until the sign-in is saved.
   *
   * @param profileFolder - The profile's folder.
   * @param profileId - The profile's id, or null for the default one.
   * @param url - The page to open, already checked.
   */
  async start(
    profileFolder: string,
    profileId: string | null,
    url: string
  ): Promise<LocalBrowserSignIn> {
    if (this.active)
      throw new LocalBrowserError('signing_in', 'Finish the sign-in that’s already open.');
    // A Chromium already on this folder would take the window over, and an agent
    // could be driving that one. Never hand a sign-in to a process we didn't start.
    if (this.isHeld(profileFolder))
      throw new LocalBrowserError(
        'profile_busy',
        'Close the browser using this profile, then try again.'
      );
    const site = new URL(url).host;
    const attempt = ++this.attempt;
    this.folder = profileFolder;
    this.record = {
      profileId,
      site,
      status: 'open',
      startedAt: new Date(this.now()).toISOString(),
    };
    try {
      await (this.deps.prepare ?? preparePlainProfile)(profileFolder);
      const executable = await (this.deps.executable ?? managedChromiumPath)();
      const spawner = this.deps.spawner ?? spawnPlainChromium;
      this.window = spawner(executable, plainChromiumArgs(profileFolder, url, site));
    } catch {
      this.finish(attempt, 'failed');
      throw new LocalBrowserError('sign_in_failed', 'Couldn’t open the sign-in window. Try again.');
    }
    const window = this.window;
    let exited = false;
    void window.exited.then((exit) => {
      exited = true;
      // No code and no signal is a process that never started.
      if (exit.code === null && exit.signal === null) this.finish(attempt, 'failed');
      else void this.save(attempt, profileFolder);
    });
    // Between the check above and the spawn, another Chromium could have taken the
    // profile, and ours would then pass the page to it and exit. Only a window
    // that holds the profile itself is the person's.
    if (!(await this.ownsProfile(profileFolder, window, () => exited))) {
      window.quit();
      this.finish(attempt, 'failed');
      this.attempt += 1;
      throw new LocalBrowserError(
        'profile_busy',
        'Close the browser using this profile, then try again.'
      );
    }
    return this.record!;
  }

  /** Ask an open window to quit; its sign-in is saved as if the person closed it. */
  close(): void {
    if (this.record?.status === 'open') this.window?.quit();
  }

  private async save(attempt: number, profileFolder: string): Promise<void> {
    if (attempt !== this.attempt || !this.record) return;
    this.record = { ...this.record, status: 'saving' };
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.now() + SIGN_IN_SAVE_TIMEOUT_MS;
    // No fixed wait: saved is when Chromium has let go of the profile.
    while (this.isHeld(profileFolder)) {
      if (this.now() >= deadline) return this.finish(attempt, 'failed');
      await sleep(SAVE_POLL_MS);
      if (attempt !== this.attempt) return;
    }
    this.finish(attempt, 'saved');
  }

  private finish(attempt: number, status: 'saved' | 'failed'): void {
    if (attempt !== this.attempt || !this.record) return;
    this.record = { ...this.record, status };
    this.window = undefined;
  }

  private async ownsProfile(
    profileFolder: string,
    window: PlainChromium,
    exited: () => boolean
  ): Promise<boolean> {
    const owner = this.deps.lockOwner ?? lockOwnerHere;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.now() + SIGN_IN_LOCK_TIMEOUT_MS;
    while (this.now() < deadline) {
      if (exited()) return false;
      const pid = owner(profileFolder);
      if (pid === 'unchecked') return true;
      if (pid !== undefined) return window.pid !== undefined && pid === window.pid;
      await sleep(SAVE_POLL_MS);
    }
    return false;
  }

  private isHeld(profileFolder: string): boolean {
    return (this.deps.held ?? profileHeld)(profileFolder);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
