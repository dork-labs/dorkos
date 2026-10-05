import { it, expect, vi } from 'vitest';
import { realpath, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { reserveProfile } from '../profiles/reservation.js';
import { parseProfileId } from '../ids.js';
import { configuration } from './parent-fixture.js';
import type { EngineConfiguration } from '../configuration.js';

it.each(['live-recorded', 'matching-recorded-gone', 'unknown'] as const)(
  'consumes fresh recorded recovery %s without deleting reservation',
  async (disposition) => {
    const root = await mkdtemp(join(tmpdir(), 'darwin-reservation-'));
    const id = parseProfileId('profile_private_recovery');
    const directory = join(root, 'reservations', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = {
      nonce: randomUUID(),
      manager: { pid: 10, birth: 'darwin-bsd-start:1:10' },
      phase: 'running',
      browser: { pid: 20, birth: 'darwin-bsd-start:1:20' },
    };
    const bytes = JSON.stringify(owner);
    const path = join(directory, 'owner.json');
    await writeFile(path, bytes, { mode: 0o600 });
    let called = false;
    const config = {
      recordedRecovery: async (selector) => {
        called = true;
        expect(selector).toEqual({
          profileId: id,
          reservationNonce: owner.nonce,
          manager: owner.manager,
          browser: owner.browser,
        });
        return disposition;
      },
    } as Pick<EngineConfiguration, 'recordedRecovery'> as EngineConfiguration;
    try {
      await expect(
        reserveProfile(config, root, id, { pid: 30, birth: 'fresh-manager' })
      ).rejects.toMatchObject({
        code: disposition === 'live-recorded' ? 'PROFILE_IN_USE' : 'PROFILE_UNCERTAIN',
      });
      expect(called).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it('persists the original journal before launch and refuses rebinding its recovery selector', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'darwin-reservation-binding-')));
  const id = parseProfileId('profile_journal_binding');
  const manager = { pid: 10, birth: 'darwin-bsd-start:1:10' };
  await mkdir(join(root, 'reservations'), { mode: 0o700 });
  await mkdir(join(root, 'profiles'), { mode: 0o700 });
  const config = configuration();
  try {
    const owner = await reserveProfile(config, root, id, manager);
    const binding = {
      journalId: 'original_journal',
      browserId: 'original_browser',
      browserGeneration: 0,
      reservationNonce: owner.nonce,
      manager,
      profile: { kind: 'persistent' as const, profileId: id },
      runtimeIdentityDigest: 'a'.repeat(64),
      bootScope: {
        kind: 'observed' as const,
        value: 'darwin-boot:1:0',
        sourceIdentityDigest: 'b'.repeat(64),
      },
    };
    expect(() => owner.recordJournal({ ...binding, reservationNonce: randomUUID() })).toThrow(
      'PROFILE_UNCERTAIN'
    );
    owner.recordJournal(binding);
    const path = join(root, 'reservations', id, 'owner.json');
    const original = await readFile(path, 'utf8');
    expect(JSON.parse(original)).toEqual({
      nonce: owner.nonce,
      manager,
      phase: 'reserved',
      journal: binding,
    });
    expect(() => owner.recordJournal({ ...binding, journalId: 'replacement_journal' })).toThrow(
      'PROFILE_UNCERTAIN'
    );
    expect(await readFile(path, 'utf8')).toBe(original);
    owner.beginLaunch();
    expect(JSON.parse(await readFile(path, 'utf8')).journal).toEqual(binding);
    // Launch entered but no original return: explicit release must retain quarantine.
    await expect(owner.release()).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('launching');
    owner.recordBrowser({ pid: 20, birth: 'original-browser' });
    owner.recordFailure('renderer');
    owner.recordFailure('browser');
    expect(JSON.parse(await readFile(path, 'utf8')).failure).toBe('renderer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds startup observation without treating timeout as original recovery completion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'darwin-reservation-timeout-')));
  const id = parseProfileId('profile_recovery_timeout');
  const directory = join(root, 'reservations', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({
    nonce: randomUUID(),
    manager: { pid: 10, birth: 'old' },
    phase: 'reserved',
  });
  const path = join(directory, 'owner.json');
  await writeFile(path, owner, { mode: 0o600 });
  let finish!: (value: 'matching-recorded-gone') => void;
  const original = new Promise<'matching-recorded-gone'>((resolve) => {
    finish = resolve;
  });
  const config = configuration();
  config.recordedRecovery = () => original;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const admission = reserveProfile(config, root, id, { pid: 30, birth: 'new' });
    const refused = expect(admission).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(1000);
    await refused;
    expect(await readFile(path, 'utf8')).toBe(owner);
    finish('matching-recorded-gone');
    await original;
    await Promise.resolve();
    expect(await readFile(path, 'utf8')).toBe(owner);
  } finally {
    vi.useRealTimers();
    finish('matching-recorded-gone');
    await rm(root, { recursive: true, force: true });
  }
});

it('charges pending recovery capacity before producer entry and refuses the ninth original without dropping custody', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'darwin-recovery-capacity-')));
  const id = parseProfileId('profile_recovery_capacity');
  const directory = join(root, 'reservations', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify({
    nonce: randomUUID(),
    manager: { pid: 10, birth: 'old' },
    phase: 'reserved',
  });
  const path = join(directory, 'owner.json');
  await writeFile(path, bytes, { mode: 0o600 });
  const completions: Array<(value: 'matching-recorded-gone') => void> = [];
  const pending: Promise<'matching-recorded-gone'>[] = [];
  let entered = 0;
  const config = configuration();
  config.recordedRecovery = () => {
    entered++;
    const original = new Promise<'matching-recorded-gone'>((resolve) => completions.push(resolve));
    pending.push(original);
    return original;
  };
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const refusals = Array.from({ length: 8 }, () =>
      expect(reserveProfile(config, root, id, { pid: 30, birth: 'new' })).rejects.toMatchObject({
        code: 'PROFILE_UNCERTAIN',
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(refusals);
    expect(entered).toBe(8);
    await expect(reserveProfile(config, root, id, { pid: 30, birth: 'new' })).rejects.toMatchObject(
      { code: 'PROFILE_UNCERTAIN' }
    );
    expect(entered).toBe(8);
    expect(pending).toHaveLength(8);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    // Only actual original completion can free its charge; timed-out classification cannot.
    for (const complete of completions) complete('matching-recorded-gone');
    await Promise.all(pending);
    await Promise.resolve();
    config.recordedRecovery = async () => {
      entered++;
      return 'matching-recorded-gone';
    };
    await expect(reserveProfile(config, root, id, { pid: 30, birth: 'new' })).rejects.toMatchObject(
      { code: 'PROFILE_UNCERTAIN' }
    );
    expect(entered).toBe(9);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  } finally {
    for (const complete of completions) complete('matching-recorded-gone');
    await Promise.all(pending);
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
