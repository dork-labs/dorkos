/** Remove a whole profile's saved data, only while every writer is excluded. */
import { lstat, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LocalBrowserError } from '../errors.js';
import { profileHeld } from '../plain-chromium.js';
import type { LocalBrowserProfileStore } from '../profile-store.js';

export interface ProfileRemovalDeps {
  dataDirectory(): string;
  busy(profileId: string | null): boolean;
  forgotten?(profileId: string | null): void;
  embedded?(): { forgetSignIns?(): Promise<void> } | undefined;
  /** Disk failure seam; production always recursively removes the whole folder. */
  remove?(folder: string): Promise<void>;
}

/** No paths or display names supplied by the caller ever become a disk target. */
export class BrowserProfileRemoval {
  private removing = false;
  constructor(private readonly deps: ProfileRemovalDeps) {}

  /** Opens and sign-ins share this synchronous fence before their first await. */
  assertAvailable(): void {
    if (this.removing)
      throw new LocalBrowserError('busy', 'Sign-ins are being cleared. Wait a moment.');
  }

  private async idle<T>(id: string | null, operation: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.deps.busy(id))
      throw new LocalBrowserError(
        'profile_busy',
        'Close the browser using this profile, then try again.'
      );
    this.removing = true;
    try {
      const result = await operation();
      this.deps.forgotten?.(id);
      return result;
    } finally {
      this.removing = false;
    }
  }

  async forget(profileId: string | null): Promise<void> {
    if (profileId !== null) z.string().uuid().parse(profileId);
    await this.idle(profileId, () => this.clear(profileId));
  }

  async delete(profileId: string, profiles: LocalBrowserProfileStore): Promise<void> {
    z.string().uuid().parse(profileId);
    await this.idle(profileId, async () => {
      if (!profiles.get(profileId))
        throw new LocalBrowserError('profile_not_found', 'That browser profile no longer exists.');
      // Disk removal must succeed before dropping its record. A failure stays retryable.
      await this.clear(profileId);
      profiles.remove(profileId);
    });
  }

  private async assertPathsAndLocks(
    home: string,
    targets: string[],
    profileId: string | null
  ): Promise<void> {
    // Refuse a redirected parent before reading a lock or deleting any data.
    for (const target of targets) {
      const relative = path.relative(home, target).split(path.sep);
      let current = home;
      for (const segment of relative) {
        current = path.join(current, segment);
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (info?.isSymbolicLink())
          throw new LocalBrowserError(
            'profile_busy',
            'Check the browser profile folder, then try again.'
          );
      }
    }
    const locks = [
      ...targets,
      ...(profileId === null ? [path.join(home, 'browser', 'profile')] : []),
    ];
    if (process.platform !== 'win32') {
      for (const folder of locks) {
        const lock = path.join(folder, 'SingletonLock');
        const info = await lstat(lock).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw new LocalBrowserError(
            'profile_busy',
            'Check the browser profile lock, then try again.'
          );
        });
        if (!info) continue;
        const owner = info.isSymbolicLink() ? await readlink(lock).catch(() => '') : '';
        if (!/-[1-9]\d*$/.test(owner))
          throw new LocalBrowserError(
            'profile_busy',
            'Check the browser profile lock, then try again.'
          );
      }
    }
    if (locks.some((folder) => profileHeld(folder)))
      throw new LocalBrowserError(
        'profile_busy',
        'Close the browser using this profile, then try again.'
      );
  }

  private async clear(profileId: string | null): Promise<void> {
    const home = this.deps.dataDirectory();
    const targets = [path.join(home, 'browser-profiles', profileId ?? 'default')];
    if (profileId === null) {
      // Both older sources can otherwise recreate the forgotten sign-ins later.
      targets.push(path.join(home, 'local-browser', 'saved-logins'), path.join(home, 'browser'));
    }
    await this.assertPathsAndLocks(home, targets, profileId);
    try {
      if (profileId === null) {
        const embedded = this.deps.embedded?.();
        if (embedded && !embedded.forgetSignIns)
          throw new LocalBrowserError(
            'unsupported',
            'Restart DorkOS before clearing browser sign-ins.'
          );
        await embedded?.forgetSignIns?.();
      }
      // Embedded cleanup can yield to an independent writer or a redirected parent.
      await this.assertPathsAndLocks(home, targets, profileId);
      // Remove the agents' exported state before its source profile, including unknown storage types.
      for (const target of targets.reverse()) {
        if (this.deps.remove) await this.deps.remove(target);
        else await rm(target, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof LocalBrowserError && error.code === 'profile_busy') throw error;
      throw new LocalBrowserError(
        'sign_ins_partial',
        "Some sign-ins couldn't be cleared. Try again."
      );
    }
  }
}
