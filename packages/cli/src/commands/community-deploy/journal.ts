/**
 * Secret-free, atomic recovery journal for Community launches.
 *
 * @module commands/community-deploy/journal
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { z } from 'zod';
import { SAFE_PROVIDER_IDENTIFIER_PATTERN } from './provider-identifiers.js';

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    SAFE_PROVIDER_IDENTIFIER_PATTERN,
    'Journal identifiers must use the provider id character set'
  );
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const HexHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const JournalLockSchema = z
  .object({ ownerId: z.uuid(), pid: z.number().int().positive(), createdAt: z.iso.datetime() })
  .strict();

/** State checkpoints that can be proved through provider readback. */
export const LaunchStateSchema = z.enum([
  'planned',
  'fly_app_created',
  'neon_project_created',
  'bucket_created',
  'secrets_staged',
  'deployed',
  'healthy',
  'owner_pending',
  'complete',
  'uncertain',
]);

/** Non-secret error categories safe to persist. */
export const LaunchErrorCategorySchema = z.enum([
  'authentication',
  'authorization',
  'billing',
  'capacity',
  'conflict',
  'transient',
  'invalid-response',
  'uncertain',
]);

/** Stable error codes allowed in a journal; raw provider messages are excluded. */
export const LaunchSafeErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'TERMS_NOT_ACCEPTED',
  'BILLING_BLOCKED',
  'QUOTA_EXCEEDED',
  'NAME_CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'INVALID_RESPONSE',
  'CREATION_OUTCOME_UNCERTAIN',
  'TERMS_VIEWER_MISSING',
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
  'JOURNAL_LOCKED',
]);

/** Canonical schema for a launch recovery journal. */
export const LaunchJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    planHash: HexHashSchema,
    releaseDigest: Sha256DigestSchema,
    state: LaunchStateSchema,
    pendingIntent: z
      .object({
        provider: z.enum(['fly', 'neon', 'tigris']),
        organizationId: SafeIdentifierSchema,
        resourceName: SafeIdentifierSchema,
        idempotencyKey: SafeIdentifierSchema.optional(),
        provenanceMarker: SafeIdentifierSchema.optional(),
      })
      .strict()
      .nullable(),
    resources: z
      .object({
        flyAppId: SafeIdentifierSchema.optional(),
        flyReleaseId: SafeIdentifierSchema.optional(),
        flyMachineId: SafeIdentifierSchema.optional(),
        flyAddressId: SafeIdentifierSchema.optional(),
        neonProjectId: SafeIdentifierSchema.optional(),
        neonBranchId: SafeIdentifierSchema.optional(),
        neonDatabaseId: SafeIdentifierSchema.optional(),
        neonRoleId: SafeIdentifierSchema.optional(),
        neonEndpointId: SafeIdentifierSchema.optional(),
        tigrisBucketId: SafeIdentifierSchema.optional(),
      })
      .strict(),
    verifiedBindings: z
      .array(
        z
          .object({
            kind: z.enum([
              'bucket-to-app',
              'endpoint-to-project',
              'machine-to-release',
              'secret-version-to-machine',
            ]),
            sourceId: SafeIdentifierSchema,
            targetId: SafeIdentifierSchema,
          })
          .strict()
      )
      .max(64),
    completedSteps: z.array(LaunchStateSchema).max(16),
    lastSafeError: z
      .object({
        category: LaunchErrorCategorySchema,
        code: LaunchSafeErrorCodeSchema,
      })
      .strict()
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/** Validated, secret-free journal record. */
export type LaunchJournal = z.infer<typeof LaunchJournalSchema>;

/** Error raised when a caller tries to overwrite a newer journal revision. */
export class LaunchJournalConflictError extends Error {
  /**
   * Create a journal revision conflict.
   *
   * @param expected - Revision the caller read.
   * @param actual - Revision currently on disk, or `null` for no journal.
   */
  constructor(expected: number | null, actual: number | null) {
    super(
      `Launch journal revision changed (expected ${expected ?? 'none'}, found ${actual ?? 'none'})`
    );
    this.name = 'LaunchJournalConflictError';
  }
}

/** Error raised when another process is updating the same launch journal. */
export class LaunchJournalLockedError extends Error {
  /** Create a stable, secret-free lock error. */
  constructor() {
    super('Another process is updating this launch journal');
    this.name = 'LaunchJournalLockedError';
  }
}

/** Error raised when a dead writer left a lock that needs explicit reconciliation. */
export class LaunchJournalStaleLockError extends Error {
  /** Stable owner id used to authorize an explicit recovery. */
  readonly ownerId: string | null;

  /**
   * Create a stale-lock error.
   *
   * @param ownerId - Parsed lock owner, or `null` for an invalid record.
   */
  constructor(ownerId: string | null) {
    super('A previous process left this launch journal locked; reconcile it before resuming');
    this.name = 'LaunchJournalStaleLockError';
    this.ownerId = ownerId;
  }
}

/**
 * Return the canonical journal path for a run.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param runId - UUID identifying one consented launch.
 * @returns Absolute path under `launches/community`.
 */
export function launchJournalPath(dorkHome: string, runId: string): string {
  const safeRunId = z.uuid().parse(runId);
  return join(dorkHome, 'launches', 'community', `${safeRunId}.json`);
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function prepareDirectory(filePath: string): Promise<void> {
  const communityDirectory = dirname(filePath);
  const launchesDirectory = dirname(communityDirectory);
  for (const directory of [launchesDirectory, communityDirectory]) {
    await rejectSymlink(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isDirectory())
        throw new Error(`Refusing non-directory: ${directory}`);
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    await rejectSymlink(directory);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeDurably(filePath: string, data: string): Promise<void> {
  const directory = dirname(filePath);
  const temporary = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.durable`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readLock(lockPath: string): Promise<z.infer<typeof JournalLockSchema> | null> {
  try {
    return JournalLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function sameFile(first: string, second: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([lstat(first), lstat(second)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

async function releaseOwnedLock(candidate: string, lockPath: string): Promise<void> {
  if (await sameFile(candidate, lockPath)) await unlink(lockPath);
  await rm(candidate, { force: true });
}

async function createLockCandidate(lockPath: string) {
  const record = { ownerId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const candidate = `${lockPath}.${record.ownerId}.candidate`;
  await writeDurably(candidate, `${JSON.stringify(record)}\n`);
  return { candidate, record };
}

async function withCrossProcessLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  if (await exists(recoveryPath)) throw new LaunchJournalLockedError();
  const { candidate } = await createLockCandidate(lockPath);
  try {
    await link(candidate, lockPath);
  } catch (error) {
    await rm(candidate, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readLock(lockPath);
      if (!existing || !processIsAlive(existing.pid)) {
        throw new LaunchJournalStaleLockError(existing?.ownerId ?? null);
      }
      throw new LaunchJournalLockedError();
    }
    throw error;
  }
  if (await exists(recoveryPath)) {
    await releaseOwnedLock(candidate, lockPath);
    throw new LaunchJournalLockedError();
  }
  try {
    return await fn();
  } finally {
    await releaseOwnedLock(candidate, lockPath);
  }
}

/**
 * Remove a dead writer's exact lock after the caller reconciles the journal.
 *
 * The operation never removes an invalid lock or one whose PID is currently
 * alive; PID reuse therefore fails conservatively as a live owner.
 *
 * @param filePath - Canonical journal path.
 * @param expectedOwnerId - Owner id reported by {@link LaunchJournalStaleLockError}.
 */
export async function recoverStaleLaunchJournalLock(
  filePath: string,
  expectedOwnerId: string
): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const recovery = await createLockCandidate(recoveryPath);
  try {
    await link(recovery.candidate, recoveryPath);
  } catch (error) {
    await rm(recovery.candidate, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LaunchJournalLockedError();
    throw error;
  }
  try {
    const record = await readLock(lockPath);
    if (!record || record.ownerId !== expectedOwnerId) {
      throw new LaunchJournalStaleLockError(record?.ownerId ?? null);
    }
    if (processIsAlive(record.pid)) throw new LaunchJournalLockedError();
    await unlink(lockPath);
    await rm(`${lockPath}.${record.ownerId}.candidate`, { force: true });
  } finally {
    await releaseOwnedLock(recovery.candidate, recoveryPath);
  }
}

/**
 * Read and validate a launch journal.
 *
 * @param filePath - Canonical path returned by {@link launchJournalPath}.
 * @returns The journal, or `null` when it has not been created.
 */
export async function readLaunchJournal(filePath: string): Promise<LaunchJournal | null> {
  await rejectSymlink(filePath);
  try {
    return LaunchJournalSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Atomically persist a validated journal with optimistic revision checking.
 *
 * @param filePath - Canonical path returned by {@link launchJournalPath}.
 * @param journal - Complete next record. Unknown fields are rejected.
 * @param expectedRevision - Revision read by the caller, or `null` for creation.
 */
export async function writeLaunchJournal(
  filePath: string,
  journal: LaunchJournal,
  expectedRevision: number | null
): Promise<void> {
  const parsed = LaunchJournalSchema.parse(journal);
  if (basename(filePath) !== `${parsed.runId}.json`) {
    throw new Error('Launch journal run id does not match its file name');
  }
  await prepareDirectory(filePath);
  await rejectSymlink(filePath);
  await withFileLock(filePath, () =>
    withCrossProcessLock(filePath, async () => {
      const current = await readLaunchJournal(filePath);
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        throw new LaunchJournalConflictError(expectedRevision, actualRevision);
      }
      if (parsed.revision !== (expectedRevision ?? -1) + 1) {
        throw new LaunchJournalConflictError((expectedRevision ?? -1) + 1, parsed.revision);
      }
      await writeDurably(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    })
  );
}

/**
 * Create a journal without a read-modify-write transaction.
 *
 * Intended for tests and one-shot initialization where the caller already owns
 * a unique UUID. Updates must use {@link writeLaunchJournal}.
 *
 * @param filePath - Canonical journal path.
 * @param journal - Revision-zero journal.
 */
export async function initializeLaunchJournal(
  filePath: string,
  journal: LaunchJournal
): Promise<void> {
  const parsed = LaunchJournalSchema.parse(journal);
  if (parsed.revision !== 0) throw new Error('A new launch journal must start at revision 0');
  await writeLaunchJournal(filePath, parsed, null);
}
