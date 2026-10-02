import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareDataRoot } from '../profiles/paths.js';
import { reserveProfile } from '../profiles/reservation.js';
import { hostIdentity } from '../runtime/host-identity.js';
import { parseProfileId } from '../ids.js';
import { fixture, configuration, profileId } from './lifecycle-fixture.js';

it('refuses a recorded live root despite a dead manager and absent native lock, then quarantines a known-dead owner', async () => {
  const owned = await fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  try {
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    const root = prepareDataRoot(config.dataDir);
    const directory = join(root, 'reservations', profileId);
    await mkdir(directory, { mode: 0o700 });
    const manager = { pid: process.pid, birth: 'definitely-different-birth' };
    const owner = {
      nonce: randomUUID(),
      manager,
      phase: 'running',
      browser: hostIdentity(child.pid!),
    };
    const file = join(directory, 'owner.json');
    await writeFile(file, JSON.stringify(owner), { mode: 0o600 });
    await expect(
      reserveProfile(config, root, parseProfileId(profileId), hostIdentity(process.pid)!)
    ).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(owner);
    child.kill('SIGTERM');
    await exited;
    await expect(
      reserveProfile(config, root, parseProfileId(profileId), hostIdentity(process.pid)!)
    ).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(owner);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await owned.close();
  }
});

it('refuses uncertain process observations, corrupt ownership and native holders without profile mutation', async () => {
  const owned = await fixture();
  try {
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    const root = prepareDataRoot(config.dataDir);
    const id = parseProfileId(profileId);
    const profile = join(root, 'profiles', id);
    await mkdir(profile, { mode: 0o700 });
    await writeFile(join(profile, 'seed'), 'UNCHANGED');
    await symlink(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    config.processes.observe = async () => ({ status: 'unknown' });
    await expect(
      reserveProfile(config, root, id, hostIdentity(process.pid)!)
    ).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(await readFile(join(profile, 'seed'), 'utf8')).toBe('UNCHANGED');
    const directory = join(root, 'reservations', id);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'owner.json'), '{corrupt', { mode: 0o600 });
    await expect(
      reserveProfile(config, root, id, hostIdentity(process.pid)!)
    ).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(await readFile(join(profile, 'seed'), 'utf8')).toBe('UNCHANGED');
    expect(await readFile(join(directory, 'owner.json'), 'utf8')).toBe('{corrupt');
  } finally {
    await owned.close();
  }
});

it('refuses a native holder under unavailable host observation and quarantines its later stale lock', async () => {
  const owned = await fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  try {
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    const root = prepareDataRoot(config.dataDir);
    const id = parseProfileId(profileId);
    const manager = hostIdentity(process.pid)!;
    const profile = join(root, 'profiles', id);
    await mkdir(profile, { mode: 0o700 });
    await writeFile(join(profile, 'seed'), 'UNCHANGED');
    await symlink(`${hostname()}-${child.pid}`, join(profile, 'SingletonLock'));
    vi.stubEnv('PATH', join(owned.root, 'no-observer'));
    await expect(reserveProfile(config, root, id, manager)).rejects.toMatchObject({
      code: 'PROCESS_OBSERVATION_UNAVAILABLE',
    });
    vi.unstubAllEnvs();
    expect(await readFile(join(profile, 'seed'), 'utf8')).toBe('UNCHANGED');
    child.kill('SIGTERM');
    await exited;
    await expect(reserveProfile(config, root, id, manager)).rejects.toMatchObject({
      code: 'UNKNOWN_NATIVE_HOLDER',
    });
    expect(await readFile(join(profile, 'seed'), 'utf8')).toBe('UNCHANGED');
  } finally {
    vi.unstubAllEnvs();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await owned.close();
  }
});

it('refuses reservation directory replacement even if copied owner bytes retain the same nonce', async () => {
  const owned = await fixture();
  try {
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    const root = prepareDataRoot(config.dataDir);
    const id = parseProfileId(profileId);
    const reservation = await reserveProfile(config, root, id, hostIdentity(process.pid)!);
    const directory = join(root, 'reservations', id);
    const bytes = await readFile(join(directory, 'owner.json'));
    await rename(directory, directory + '-original');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'owner.json'), bytes, { mode: 0o600 });
    await expect(reservation.release()).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(await readFile(join(directory, 'owner.json'))).toEqual(bytes);
  } finally {
    await owned.close();
  }
});
