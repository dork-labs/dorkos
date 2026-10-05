import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { reserveProfile } from '../profiles/reservation.js';
import { parseProfileId } from '../ids.js';
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
