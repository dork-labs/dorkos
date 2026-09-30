/**
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeLaunchJournal,
  launchJournalPath,
  listIncompleteLaunchJournals,
  LaunchJournalConflictError,
  LaunchJournalLockedError,
  LaunchSafeErrorCodeSchema,
  LaunchJournalStaleLockError,
  readLaunchJournal,
  recoverStaleLaunchJournalLock,
  writeLaunchJournal,
  type LaunchJournal,
} from '../journal.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dorkos-community-journal-'));
  roots.push(value);
  return value;
}

function journal(runId: string, revision = 0): LaunchJournal {
  return {
    schemaVersion: 1,
    runId,
    revision,
    planHash: 'b'.repeat(64),
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    state: 'planned',
    pendingIntent: null,
    resources: {},
    verifiedBindings: [],
    completedSteps: ['planned'],
    lastSafeError: null,
    createdAt: '2026-09-21T04:00:00.000Z',
    updatedAt: '2026-09-21T04:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('Community launch journal', () => {
  it('accepts every safe Fly and bounded-process classification without provider text', () => {
    expect(
      [
        'TERMS_VIEWER_MISSING',
        'TERMS_NOT_ACCEPTED',
        'ADD_ON_MISSING',
        'INVALID_EXPECTED_BINDING',
        'BINDING_MISMATCH',
        'PUBLIC_BUCKET',
        'INVALID_INPUT',
        'MISSING_TIGRIS_SECRETS',
        'CREDENTIAL_DISPOSED',
        'SPAWN',
        'TIMEOUT',
        'OUTPUT_LIMIT',
        'EXIT',
        'COMMUNITY_RELEASE_NOT_READY',
        'COMMUNITY_RELEASE_INVALID',
        'COMMUNITY_RELEASE_VERSION_MISMATCH',
        'COMMUNITY_RELEASE_PROVENANCE_MISMATCH',
        'CANCELLED',
      ].map((code) => LaunchSafeErrorCodeSchema.parse(code))
    ).toEqual([
      'TERMS_VIEWER_MISSING',
      'TERMS_NOT_ACCEPTED',
      'ADD_ON_MISSING',
      'INVALID_EXPECTED_BINDING',
      'BINDING_MISMATCH',
      'PUBLIC_BUCKET',
      'INVALID_INPUT',
      'MISSING_TIGRIS_SECRETS',
      'CREDENTIAL_DISPOSED',
      'SPAWN',
      'TIMEOUT',
      'OUTPUT_LIMIT',
      'EXIT',
      'COMMUNITY_RELEASE_NOT_READY',
      'COMMUNITY_RELEASE_INVALID',
      'COMMUNITY_RELEASE_VERSION_MISMATCH',
      'COMMUNITY_RELEASE_PROVENANCE_MISMATCH',
      'CANCELLED',
    ]);
  });

  it('writes atomically with private permissions and round-trips validated state', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    await initializeLaunchJournal(path, journal(runId));

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readLaunchJournal(path)).toEqual(journal(runId));
    expect(await readFile(path, 'utf8')).not.toContain('password');
  });

  it('lists only incomplete validated journals in most-recent order', async () => {
    const dorkHome = await root();
    const first = randomUUID();
    const second = randomUUID();
    const complete = randomUUID();
    await initializeLaunchJournal(launchJournalPath(dorkHome, first), journal(first));
    await initializeLaunchJournal(launchJournalPath(dorkHome, second), {
      ...journal(second),
      state: 'owner_pending',
      updatedAt: '2026-09-21T05:00:00.000Z',
    });
    await initializeLaunchJournal(launchJournalPath(dorkHome, complete), {
      ...journal(complete),
      state: 'complete',
      completedSteps: ['planned', 'complete'],
    });

    expect((await listIncompleteLaunchJournals(dorkHome)).map((item) => item.runId)).toEqual([
      second,
      first,
    ]);
  });

  it('rejects stale revisions and concurrent initialization', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    await initializeLaunchJournal(path, journal(runId));

    const results = await Promise.allSettled([
      writeLaunchJournal(path, { ...journal(runId, 1), state: 'fly_app_created' }, 0),
      writeLaunchJournal(path, { ...journal(runId, 1), state: 'neon_project_created' }, 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(LaunchJournalConflictError) });
    await expect(initializeLaunchJournal(path, journal(runId))).rejects.toBeInstanceOf(
      LaunchJournalConflictError
    );
  });

  it('rejects symbolic links in the journal path', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    const target = join(dorkHome, 'target.json');
    await symlink(target, path).catch(async () => {
      const directory = join(dorkHome, 'launches', 'community');
      await mkdir(directory, { recursive: true });
      await symlink(target, path);
    });

    await expect(initializeLaunchJournal(path, journal(runId))).rejects.toThrow(
      'Refusing symbolic link'
    );
  });

  it('refuses a journal held by another process', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    await mkdir(join(dorkHome, 'launches', 'community'), { recursive: true });
    await writeFile(
      `${path}.lock`,
      `${JSON.stringify({ ownerId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    );

    await expect(initializeLaunchJournal(path, journal(runId))).rejects.toBeInstanceOf(
      LaunchJournalLockedError
    );
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires explicit reconciliation after a lock owner dies', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const ownerId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    await mkdir(join(dorkHome, 'launches', 'community'), { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    if (!child.pid) throw new Error('Test child did not start');
    const candidate = `${path}.lock.${ownerId}.candidate`;
    await writeFile(
      candidate,
      `${JSON.stringify({ ownerId, pid: child.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    );
    await link(candidate, `${path}.lock`);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    await expect(initializeLaunchJournal(path, journal(runId))).rejects.toMatchObject({
      name: 'LaunchJournalStaleLockError',
      ownerId,
    });
    await recoverStaleLaunchJournalLock(path, ownerId);
    await initializeLaunchJournal(path, journal(runId));
    expect(await readLaunchJournal(path)).toEqual(journal(runId));
  });

  it('will not recover a live or mismatched lock owner', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const ownerId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    await mkdir(join(dorkHome, 'launches', 'community'), { recursive: true });
    await writeFile(
      `${path}.lock`,
      `${JSON.stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    );

    await expect(recoverStaleLaunchJournalLock(path, ownerId)).rejects.toBeInstanceOf(
      LaunchJournalLockedError
    );
    await expect(recoverStaleLaunchJournalLock(path, randomUUID())).rejects.toBeInstanceOf(
      LaunchJournalStaleLockError
    );
  });

  // Journals written before provenance markers shipped carry none of the new fields, and some
  // stopped mid-create with an intent that has no marker. Both must still load so they can resume.
  it('loads a journal written before provenance markers from disk', async () => {
    const directory = await root();
    const runId = randomUUID();
    const filePath = launchJournalPath(directory, runId);
    await mkdir(join(directory, 'launches', 'community'), { recursive: true });
    const legacy = {
      ...journal(runId, 3),
      state: 'uncertain',
      pendingIntent: { provider: 'fly', organizationId: 'dork-labs', resourceName: 'community-a' },
      resources: {},
      lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    };
    await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const loaded = await readLaunchJournal(filePath);
    expect(loaded).toEqual(legacy);
    expect(loaded?.pendingIntent?.provenanceMarker).toBeUndefined();
    expect(loaded?.provenance).toBeUndefined();
  });

  it('round-trips an intent marker, its request time, read-back provenance and removals', async () => {
    const directory = await root();
    const runId = randomUUID();
    const filePath = launchJournalPath(directory, runId);
    const marked: LaunchJournal = {
      ...journal(runId),
      pendingIntent: {
        provider: 'neon',
        organizationId: 'org-dorian',
        resourceName: 'community-a',
        provenanceMarker: '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
        requestedAt: '2026-09-23T10:31:03.000Z',
      },
      provenance: { flyNetwork: 'dorkos-0123456789abcdef0123456789abcdef' },
      removals: [
        {
          provider: 'tigris',
          token: 'addon_removed_01',
          resourceName: 'community-a',
          proof: 'binding',
          priorSecretDigests: {
            AWS_ACCESS_KEY_ID: 'old-access',
            AWS_SECRET_ACCESS_KEY: 'old-secret',
          },
          requestedAt: '2026-09-23T10:40:00.000Z',
          removedAt: '2026-09-23T10:41:00.000Z',
        },
      ],
    };
    await initializeLaunchJournal(filePath, marked);
    await expect(readLaunchJournal(filePath)).resolves.toEqual(marked);
  });

  it('accepts only 32 lowercase hex characters as a provenance marker', async () => {
    const directory = await root();
    for (const provenanceMarker of [
      '7F3E0B9C4D2A41E8A6C5B3F1D0E9C21A',
      'abc',
      `${'a'.repeat(31)}-`,
    ]) {
      const runId = randomUUID();
      await expect(
        initializeLaunchJournal(launchJournalPath(directory, runId), {
          ...journal(runId),
          pendingIntent: {
            provider: 'fly',
            organizationId: 'dork-labs',
            resourceName: 'community-a',
            provenanceMarker,
          },
        }),
        provenanceMarker
      ).rejects.toThrow();
    }
  });

  it('rejects unknown and secret-shaped fields instead of serializing them', async () => {
    const dorkHome = await root();
    const runId = randomUUID();
    const path = launchJournalPath(dorkHome, runId);
    const unsafe = {
      ...journal(runId),
      databaseUrl: 'postgresql://owner:CANARY_SECRET@example.invalid/db',
    };

    await expect(initializeLaunchJournal(path, unsafe as LaunchJournal)).rejects.toThrow();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      initializeLaunchJournal(path, {
        ...journal(runId),
        resources: { neonEndpointId: 'postgresql://owner:CANARY_SECRET@example.invalid/db' },
      })
    ).rejects.toThrow('Journal identifiers must use the provider id character set');

    await expect(
      initializeLaunchJournal(path, {
        ...journal(runId),
        lastSafeError: { category: 'authorization', code: 'provider said CANARY_SECRET' as never },
      })
    ).rejects.toThrow();
  });
});
