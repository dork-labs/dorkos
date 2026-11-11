/** Remove a whole profile's saved data, only while every writer is excluded. */
import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { recordAudit } from '../../../audit/audit-trail.js';
import { LocalBrowserError } from '../errors.js';
import { profileHeld } from '../plain-chromium.js';
import type { LocalBrowserProfileStore } from '../profile-store.js';

/**
 * What Forget found changed outside DorkOS (DOR-4172): the profiles folder itself, or a
 * parent on a profile's path, isn't a real folder; or a link sits where a profile was.
 */
export type ProfileTamperFinding = 'root_not_directory' | 'planted_link';

/**
 * A tamper record names what was found and which profile (`default`, a uuid, or null for
 * the profiles folder as a whole). Never a path or any contents.
 */
export type ProfileTamperWriter = (finding: ProfileTamperFinding, profileId: string | null) => void;

export interface ProfileRemovalDeps {
  dataDirectory(): string;
  busy(profileId: string | null): boolean;
  forgotten?(profileId: string | null): void;
  embedded?(): { forgetSignIns?(): Promise<void> } | undefined;
  /** Disk failure seam; production always recursively removes the whole folder. */
  remove?(folder: string): Promise<void>;
  /** Audit seam; production writes one audit event per finding. */
  tampered?: ProfileTamperWriter;
}

/** The refusal for a folder changed outside DorkOS. Trying again can't fix it. */
function folderChanged(): LocalBrowserError {
  return new LocalBrowserError(
    'profiles_folder_changed',
    'Sign-ins weren’t forgotten. Their folder was changed outside DorkOS, so DorkOS left it alone.'
  );
}

/**
 * Record a tamper finding in the audit trail. The last writer isn't tracked, so the actor
 * is whoever asked for the Forget; the target is the profile id alone.
 */
const auditTamper: ProfileTamperWriter = (finding, profileId) => {
  recordAudit({
    action: `local_browser.profiles.${finding}`,
    operation: 'remove',
    summary:
      finding === 'planted_link'
        ? 'Removed a link planted in an Agent browser profile'
        : 'Refused to forget sign-ins: their folder was changed outside DorkOS',
    outcome: finding === 'planted_link' ? 'ok' : 'refused',
    target: profileId === null ? null : { type: 'browser-profile', id: profileId },
  });
};

/** No paths or display names supplied by the caller ever become a disk target. */
export class BrowserProfileRemoval {
  private removing = false;
  private readonly tampered: ProfileTamperWriter;
  constructor(private readonly deps: ProfileRemovalDeps) {
    this.tampered = deps.tampered ?? auditTamper;
  }

  /**
   * The profiles folder must be a real folder, or missing. Checked before the lock wait
   * and again right before each removal, so a swap mid-Forget still stops it.
   */
  private async assertRoot(root: string): Promise<void> {
    const info = await lstat(root).catch(() => undefined);
    if (info && !info.isDirectory()) {
      this.tampered('root_not_directory', null);
      throw folderChanged();
    }
  }

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

  /**
   * Forget every saved sign-in: the default profile and each named one (DOR-4105). The
   * panel shows one Saved sign-ins row, so its Forget has to leave no hidden sign-in behind.
   * Every profile must be free first, so a busy one stops it before anything is cleared.
   *
   * @param namedIds - Every named profile on record.
   */
  async forgetAll(namedIds: readonly string[]): Promise<void> {
    for (const id of namedIds) z.string().uuid().parse(id);
    // A profile folder made outside the API (an agent with a shell can make one) is
    // cleared too, so no sign-in survives Forget just because it's off the list.
    const root = path.join(this.deps.dataDirectory(), 'browser-profiles');
    // The profiles folder itself must be a real folder. If it was swapped for a link,
    // Forget would walk somewhere else, so it refuses and clears nothing.
    await this.assertRoot(root);
    const onDisk = await readdir(root).catch(() => [] as string[]);
    const ids = [
      ...new Set([
        ...namedIds,
        ...onDisk.filter((name) => z.string().uuid().safeParse(name).success),
      ]),
    ];
    // Only a real folder is cleared. Anything else under a profile's name (a link an agent
    // planted to the person's own folder, say) is removed itself and never followed.
    const folders: string[] = [];
    const planted: string[] = [];
    for (const id of ids) {
      const info = await lstat(path.join(root, id)).catch(() => undefined);
      (!info || info.isDirectory() ? folders : planted).push(id);
    }
    if (ids.some((id) => this.deps.busy(id)))
      throw new LocalBrowserError(
        'profile_busy',
        'Close the browser using this profile, then try again.'
      );
    await this.idle(null, async () => {
      await this.assertRoot(root);
      await this.clear(null);
      for (const id of planted) {
        await this.assertRoot(root);
        await rm(path.join(root, id), { force: true });
        this.tampered('planted_link', id);
      }
      for (const id of folders) {
        await this.assertRoot(root);
        await this.clear(id);
      }
      for (const id of ids) this.deps.forgotten?.(id);
    });
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
        if (info?.isSymbolicLink()) {
          // A link on the path means the folder was changed outside DorkOS. The record
          // names the profile, never where the link points.
          this.tampered('planted_link', profileId ?? 'default');
          throw folderChanged();
        }
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
      if (
        error instanceof LocalBrowserError &&
        (error.code === 'profile_busy' || error.code === 'profiles_folder_changed')
      )
        throw error;
      throw new LocalBrowserError(
        'sign_ins_partial',
        "Some sign-ins couldn't be cleared. Try again."
      );
    }
  }
}
