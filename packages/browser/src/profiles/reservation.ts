import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { EngineConfiguration, ProcessIdentity } from '../configuration.js';
import type { ProfileId } from '../ids.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { deadline } from '../lifecycle/deadline.js';
import { nativeHolder } from '../runtime/host-identity.js';
import { ownDirectory, assertDirectory } from './owned-directory.js';
import { privateDirectory } from './paths.js';

const identity = z
  .object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) })
  .strict();
const OwnerSchema = z
  .object({
    nonce: z.string().uuid(),
    manager: identity,
    phase: z.enum(['reserved', 'launching', 'running']),
    browser: identity.optional(),
  })
  .strict()
  .refine((owner) => (owner.phase === 'running' ? !!owner.browser : !owner.browser));
type Owner = z.infer<typeof OwnerSchema>;

async function assertDead(config: EngineConfiguration, holder: ProcessIdentity): Promise<void> {
  const abort = new AbortController();
  try {
    const result = await deadline(
      config.processes.observe(holder, abort.signal),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
    if (result.status === 'alive') throw new BrowserLifecycleError('PROFILE_IN_USE');
    if (result.status !== 'dead') throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  } finally {
    abort.abort();
  }
}

function readOwner(file: string): Owner {
  try {
    const entry = lstatSync(file);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > 2048 ||
      (entry.mode & 0o077) !== 0
    )
      throw new Error();
    return OwnerSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  }
}

/** An acquired atomic reservation, never a public filesystem capability. */
export interface ProfileReservation {
  readonly profileDir: string;
  beginLaunch(): void;
  recordBrowser(browser: ProcessIdentity): void;
  release(): Promise<void>;
}

/** Reserve before changing profile data; uncertain interrupted launches require explicit repair. */
export async function reserveProfile(
  config: EngineConfiguration,
  root: string,
  profileId: ProfileId,
  manager: ProcessIdentity
): Promise<ProfileReservation> {
  const directory = join(root, 'reservations', profileId);
  const ownerFile = join(directory, 'owner.json');
  const profileDir = join(root, 'profiles', profileId);
  let acquired = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    acquired = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!acquired) {
    privateDirectory(directory);
    const prior = readOwner(ownerFile);
    await assertDead(config, prior.manager);
    if (prior.browser) await assertDead(config, prior.browser);
    // Reconciliation/recovery belongs to the next slice. A dead owner is not a repair instruction.
    throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  }
  let reservationDirectory: ReturnType<typeof ownDirectory> | undefined;
  let profileDirectory: ReturnType<typeof ownDirectory> | undefined;
  const owner: Owner = { nonce: randomUUID(), manager, phase: 'reserved' };
  const persist = (): void => {
    const temporary = join(directory, owner.nonce + '.tmp');
    writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, ownerFile);
  };
  const assertOwned = (): void => {
    if (!reservationDirectory || !profileDirectory)
      throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
    assertDirectory(reservationDirectory);
    assertDirectory(profileDirectory);
    if (JSON.stringify(readOwner(ownerFile)) !== JSON.stringify(owner))
      throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  };
  try {
    reservationDirectory = ownDirectory(directory);
    persist();
    privateDirectory(profileDir);
    profileDirectory = ownDirectory(profileDir);
    const native = nativeHolder(profileDir);
    if (native) await assertDead(config, native);
  } catch (error) {
    try {
      assertOwned();
      rmSync(directory, { recursive: true });
    } catch {
      throw new BrowserLifecycleError(
        error instanceof BrowserLifecycleError ? error.code : 'PROFILE_SETUP_FAILED',
        'PROFILE_UNCERTAIN'
      );
    }
    throw error;
  }
  return {
    profileDir,
    beginLaunch() {
      assertOwned();
      owner.phase = 'launching';
      persist();
    },
    recordBrowser(browser) {
      assertOwned();
      owner.phase = 'running';
      owner.browser = browser;
      persist();
    },
    async release() {
      assertOwned();
      if (owner.phase === 'launching') throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
      if (owner.browser) await assertDead(config, owner.browser);
      const native = nativeHolder(profileDir);
      if (native) await assertDead(config, native);
      assertOwned();
      rmSync(directory, { recursive: true });
    },
  };
}
