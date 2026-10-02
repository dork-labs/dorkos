import { it, expect, vi } from 'vitest';
import { mkdir, writeFile, readFile, rename, access, chmod } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareDataRoot } from '../profiles/paths.js';
import { reserveProfile } from '../profiles/reservation.js';
import { hostIdentity } from '../runtime/host-identity.js';
import { parseProfileId } from '../ids.js';
import { createBrowserEngine } from '../index.js';
import { fixture, configuration, profileId, requestId } from './lifecycle-fixture.js';

const launch = vi.hoisted(() =>
  vi.fn(() => {
    throw Error('UNEXPECTED_BROWSER_ACQUISITION');
  })
);
vi.mock('../runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ launchPersistentContext: launch }),
}));

async function setup() {
  const owned = await fixture();
  try {
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    const root = prepareDataRoot(config.dataDir);
    const directory = join(root, 'reservations', profileId);
    const profile = join(root, 'profiles', profileId);
    await mkdir(profile, { mode: 0o700 });
    await writeFile(join(profile, 'seed'), 'UNCHANGED');
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    return { owned, config, root, directory, profile, file: join(directory, 'owner.json') };
  } catch (error) {
    await owned.close();
    throw error;
  }
}

it('removes only an unchanged owned setup reservation and preserves the original refusal/profile', async () => {
  const state = await setup();
  try {
    state.config.processes.observe = async () => ({ status: 'alive' });
    await expect(
      reserveProfile(
        state.config,
        state.root,
        parseProfileId(profileId),
        hostIdentity(process.pid)!
      )
    ).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
    await expect(access(state.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(state.profile, 'seed'), 'utf8')).toBe('UNCHANGED');
  } finally {
    await state.owned.close();
  }
});

for (const alteration of [
  'reservation-directory',
  'profile-directory',
  'full-owner',
  'nonce',
  'corrupt-owner',
] as const) {
  it(`quarantines setup cleanup after ${alteration} replacement without losing the primary refusal`, async () => {
    const state = await setup();
    let retainedOwner = '';
    try {
      state.config.processes.observe = async () => {
        const owner = JSON.parse(await readFile(state.file, 'utf8'));
        if (alteration === 'reservation-directory') {
          await rename(state.directory, state.directory + '-original');
          await mkdir(state.directory, { mode: 0o700 });
          await writeFile(state.file, JSON.stringify(owner), { mode: 0o600 });
        } else if (alteration === 'profile-directory') {
          await rename(state.profile, state.profile + '-original');
          await mkdir(state.profile, { mode: 0o700 });
          await writeFile(join(state.profile, 'seed'), 'REPLACEMENT');
        } else {
          if (alteration === 'full-owner') owner.manager.birth = 'changed-birth-same-nonce';
          if (alteration === 'nonce') owner.nonce = randomUUID();
          await writeFile(
            state.file,
            alteration === 'corrupt-owner' ? '{corrupt' : JSON.stringify(owner)
          );
        }
        await writeFile(join(state.directory, 'marker'), 'PRESERVE');
        retainedOwner = await readFile(state.file, 'utf8');
        return { status: 'alive' };
      };
      const refusal = await reserveProfile(
        state.config,
        state.root,
        parseProfileId(profileId),
        hostIdentity(process.pid)!
      ).catch((error: unknown) => error);
      expect(await readFile(join(state.directory, 'marker'), 'utf8')).toBe('PRESERVE');
      expect(await readFile(state.file, 'utf8')).toBe(retainedOwner);
      expect(refusal).toMatchObject({ code: 'PROFILE_IN_USE', cleanupCode: 'PROFILE_UNCERTAIN' });
      expect(await readFile(join(state.profile, 'seed'), 'utf8')).toBe(
        alteration === 'profile-directory' ? 'REPLACEMENT' : 'UNCHANGED'
      );
    } finally {
      await state.owned.close();
    }
  });
}

it('retains setup ownership when an existing profile cannot be bound as a private directory', async () => {
  const state = await setup();
  try {
    await chmod(state.profile, 0o755);
    const refusal = await reserveProfile(
      state.config,
      state.root,
      parseProfileId(profileId),
      hostIdentity(process.pid)!
    ).catch((error: unknown) => error);
    await expect(access(state.file)).resolves.toBeUndefined();
    expect(refusal).toMatchObject({ code: 'UNSAFE_DIRECTORY', cleanupCode: 'PROFILE_UNCERTAIN' });
    expect(await readFile(join(state.profile, 'seed'), 'utf8')).toBe('UNCHANGED');
  } finally {
    await state.owned.close();
  }
});

it('preserves setup cleanup uncertainty in public open and idempotent shutdown without acquiring a browser', async () => {
  const state = await setup();
  launch.mockClear();
  let observations = 0;
  const descendants = vi.fn(async () => ({ status: 'unknown' as const, identities: [] }));
  try {
    state.config.processes.observe = async () => {
      observations++;
      await writeFile(state.file, '{corrupt');
      return { status: 'alive' };
    };
    state.config.processes.descendants = descendants;
    const engine = createBrowserEngine(state.config);
    const refusal = await engine
      .open({ kind: 'open', requestId, mode: 'persistent', profileId })
      .catch((error: unknown) => error);
    const outcomes = await engine.shutdown();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ cleanup: 'unverified', reason: 'observationUnavailable' });
    expect(await engine.shutdown()).toBe(outcomes);
    expect(refusal).toMatchObject({ code: 'PROFILE_IN_USE', cleanupCode: 'PROFILE_UNCERTAIN' });
    expect(await readFile(state.file, 'utf8')).toBe('{corrupt');
    expect(observations).toBe(1);
    expect(descendants).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    await state.owned.close();
  }
});
