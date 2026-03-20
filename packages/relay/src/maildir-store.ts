/**
 * Maildir-based message storage for the Relay message bus.
 *
 * Implements the Maildir convention for atomic message delivery:
 * - `tmp/`    — in-flight writes (not yet delivered)
 * - `new/`    — delivered, unclaimed messages
 * - `cur/`    — messages currently being processed
 * - `failed/` — dead letter queue (rejected/failed messages)
 *
 * Each endpoint gets its own Maildir directory identified by an endpoint
 * hash. Delivery uses atomic POSIX rename (`tmp/` -> `new/`) to guarantee
 * that consumers never see partial writes.
 *
 * File writes use `O_CREAT | O_EXCL` flags (exclusive create) to prevent
 * accidental overwrites. ULID filenames provide monotonic, lexicographically
 * sortable message ordering.
 *
 * @module relay/maildir-store
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { monotonicFactory } from 'ulidx';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { DeadLetter } from './types.js';

// === Constants ===

/** Directory permission: rwx for owner only. */
const DIR_MODE = 0o700;

/** File permission: rw for owner only. */
const FILE_MODE = 0o600;

/** Maildir subdirectory names. */
const MAILDIR_SUBDIRS = ['tmp', 'new', 'cur', 'failed'] as const;

/** Type for Maildir subdirectory names. */
type MaildirSubdir = (typeof MAILDIR_SUBDIRS)[number];

/** File extension for envelope JSON files. */
const FILE_EXT = '.json';

// === ULID Generator ===

/** Monotonic ULID factory — guarantees ordering within the same millisecond. */
const generateUlid = monotonicFactory();

// === Types ===

/** Options for creating a MaildirStore. */
export interface MaildirStoreOptions {
  /** Root directory for all mailboxes (e.g. `~/.dork/relay/mailboxes/`). */
  rootDir: string;
}

/**
 * Result of a deliver operation — either success with the message ID,
 * or failure with an error reason.
 */
export type DeliverResult =
  | { ok: true; messageId: string; path: string }
  | { ok: false; error: string };

/**
 * Result of a claim operation — moves a message from `new/` to `cur/`.
 */
export type ClaimResult =
  | { ok: true; envelope: RelayEnvelope; path: string }
  | { ok: false; error: string };

/**
 * Result of a fail operation — moves a message from `cur/` to `failed/`.
 */
export type FailResult = { ok: true; path: string } | { ok: false; error: string };

// === MaildirStore ===

/**
 * Maildir-based message store for Relay endpoints.
 *
 * Each endpoint (identified by its hash) gets a dedicated Maildir
 * directory under the root. Messages flow through the standard
 * Maildir lifecycle: `tmp/` -> `new/` -> `cur/` -> (complete or `failed/`).
 *
 * @example
 * ```ts
 * const store = new MaildirStore({ rootDir: '/home/user/.dork/relay/mailboxes' });
 * const result = await store.deliver('a1b2c3', envelope);
 * if (result.ok) {
 *   console.log(`Delivered as ${result.messageId}`);
 * }
 * ```
 */
export class MaildirStore {
  private readonly rootDir: string;

  constructor(options: MaildirStoreOptions) {
    this.rootDir = options.rootDir;
  }

  // --- Directory Management ---

  /**
   * Ensure the Maildir directory structure exists for an endpoint.
   *
   * Creates `{rootDir}/{endpointHash}/{tmp,new,cur,failed}/` with
   * `0o700` permissions. Safe to call multiple times (idempotent).
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   */
  async ensureMaildir(endpointHash: string): Promise<void> {
    const base = this.endpointDir(endpointHash);
    for (const subdir of MAILDIR_SUBDIRS) {
      await fs.mkdir(path.join(base, subdir), { recursive: true, mode: DIR_MODE });
    }
  }

  // --- Delivery ---

  /**
   * Atomically deliver an envelope to an endpoint's mailbox.
   *
   * Write flow:
   * 1. Serialize envelope to JSON
   * 2. Write to `tmp/{ulid}.json` with `O_CREAT | O_EXCL` (exclusive create)
   * 3. Atomic rename from `tmp/{ulid}.json` to `new/{ulid}.json`
   *
   * If the rename fails, the tmp file is cleaned up on a best-effort basis.
   *
   * @param endpointHash - The hash identifying the target endpoint's mailbox.
   * @param envelope - The relay envelope to deliver.
   * @returns A DeliverResult indicating success or failure.
   */
  async deliver(endpointHash: string, envelope: RelayEnvelope): Promise<DeliverResult> {
    const messageId = generateUlid();
    const filename = messageId + FILE_EXT;
    const base = this.endpointDir(endpointHash);
    const tmpPath = path.join(base, 'tmp', filename);
    const newPath = path.join(base, 'new', filename);

    try {
      // Step 1: Write to tmp/ with exclusive create
      const data = JSON.stringify(envelope, null, 2);
      await writeFileExclusive(tmpPath, data);

      // Step 2: Atomic rename to new/
      await fs.rename(tmpPath, newPath);

      return { ok: true, messageId, path: newPath };
    } catch (err) {
      // Best-effort cleanup of tmp file
      await silentUnlink(tmpPath);

      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `delivery failed: ${message}` };
    }
  }

  // --- Claim ---

  /**
   * Claim a message from `new/` by moving it to `cur/` for processing.
   *
   * The rename from `new/` to `cur/` is atomic, so only one consumer
   * can successfully claim a given message even under concurrency.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param messageId - The ULID of the message to claim.
   * @returns A ClaimResult with the parsed envelope on success.
   */
  async claim(endpointHash: string, messageId: string): Promise<ClaimResult> {
    const filename = messageId + FILE_EXT;
    const base = this.endpointDir(endpointHash);
    const newPath = path.join(base, 'new', filename);
    const curPath = path.join(base, 'cur', filename);

    try {
      // Atomic rename — only one consumer can succeed
      await fs.rename(newPath, curPath);

      // Read and parse the envelope
      const data = await fs.readFile(curPath, 'utf-8');
      const envelope = JSON.parse(data) as RelayEnvelope;

      return { ok: true, envelope, path: curPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `claim failed: ${message}` };
    }
  }

  // --- Complete ---

  /**
   * Mark a message as successfully processed by removing it from `cur/`.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param messageId - The ULID of the message to complete.
   */
  async complete(endpointHash: string, messageId: string): Promise<void> {
    const filename = messageId + FILE_EXT;
    const curPath = path.join(this.endpointDir(endpointHash), 'cur', filename);
    await fs.unlink(curPath);
  }

  // --- Fail ---

  /**
   * Move a message from `cur/` to `failed/` (dead letter queue).
   *
   * A companion `.reason.json` sidecar file is written alongside the
   * failed message containing the dead letter metadata.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param messageId - The ULID of the message that failed.
   * @param reason - Human-readable reason for the failure.
   * @returns A FailResult indicating success or failure.
   */
  async fail(endpointHash: string, messageId: string, reason: string): Promise<FailResult> {
    const filename = messageId + FILE_EXT;
    const base = this.endpointDir(endpointHash);
    const curPath = path.join(base, 'cur', filename);
    const failedPath = path.join(base, 'failed', filename);

    try {
      // Move envelope from cur/ to failed/
      await fs.rename(curPath, failedPath);

      // Read envelope to build dead letter metadata
      const data = await fs.readFile(failedPath, 'utf-8');
      const envelope = JSON.parse(data) as RelayEnvelope;

      const deadLetter: DeadLetter = {
        envelope,
        reason,
        failedAt: new Date().toISOString(),
        endpointHash,
      };

      // Write sidecar with dead letter details
      const reasonPath = path.join(base, 'failed', `${messageId}.reason.json`);
      await writeFileExclusive(reasonPath, JSON.stringify(deadLetter, null, 2));

      return { ok: true, path: failedPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `fail operation failed: ${message}` };
    }
  }

  /**
   * Move a message directly to `failed/` without it being in `cur/` first.
   *
   * Used for pre-delivery rejections (budget exceeded, access denied, etc.)
   * where the envelope never entered the normal Maildir flow.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param envelope - The rejected envelope.
   * @param reason - Human-readable reason for the rejection.
   * @returns A FailResult indicating success or failure.
   */
  async failDirect(
    endpointHash: string,
    envelope: RelayEnvelope,
    reason: string
  ): Promise<FailResult> {
    const messageId = envelope.id;
    const filename = messageId + FILE_EXT;
    const base = this.endpointDir(endpointHash);
    const failedPath = path.join(base, 'failed', filename);

    try {
      // Write envelope directly to failed/
      await writeFileExclusive(failedPath, JSON.stringify(envelope, null, 2));

      const deadLetter: DeadLetter = {
        envelope,
        reason,
        failedAt: new Date().toISOString(),
        endpointHash,
      };

      // Write sidecar with dead letter details
      const reasonPath = path.join(base, 'failed', `${messageId}.reason.json`);
      await writeFileExclusive(reasonPath, JSON.stringify(deadLetter, null, 2));

      return { ok: true, path: failedPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `failDirect operation failed: ${message}` };
    }
  }

  // --- List ---

  /**
   * List all message IDs in `new/` for an endpoint, sorted by ULID (FIFO order).
   *
   * Only returns `.json` files (ignores sidecar files and other artifacts).
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @returns Array of message IDs (ULIDs without extension), sorted ascending.
   */
  async listNew(endpointHash: string): Promise<string[]> {
    return this.listSubdir(endpointHash, 'new');
  }

  /**
   * List all message IDs in `cur/` for an endpoint, sorted by ULID.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @returns Array of message IDs (ULIDs without extension), sorted ascending.
   */
  async listCurrent(endpointHash: string): Promise<string[]> {
    return this.listSubdir(endpointHash, 'cur');
  }

  /**
   * List all message IDs in `failed/` for an endpoint, sorted by ULID.
   *
   * Only returns envelope files (filters out `.reason.json` sidecars).
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @returns Array of message IDs (ULIDs without extension), sorted ascending.
   */
  async listFailed(endpointHash: string): Promise<string[]> {
    return this.listSubdir(endpointHash, 'failed');
  }

  // --- Read ---

  /**
   * Read an envelope from a specific Maildir subdirectory.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param subdir - The Maildir subdirectory to read from.
   * @param messageId - The ULID of the message.
   * @returns The parsed RelayEnvelope, or null if not found.
   */
  async readEnvelope(
    endpointHash: string,
    subdir: MaildirSubdir,
    messageId: string
  ): Promise<RelayEnvelope | null> {
    const filename = messageId + FILE_EXT;
    const filePath = path.join(this.endpointDir(endpointHash), subdir, filename);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as RelayEnvelope;
    } catch {
      return null;
    }
  }

  /**
   * Read a dead letter record from the failed directory.
   *
   * @param endpointHash - The hash identifying the endpoint's mailbox.
   * @param messageId - The ULID of the failed message.
   * @returns The parsed DeadLetter, or null if not found.
   */
  async readDeadLetter(endpointHash: string, messageId: string): Promise<DeadLetter | null> {
    const reasonPath = path.join(
      this.endpointDir(endpointHash),
      'failed',
      `${messageId}.reason.json`
    );

    try {
      const data = await fs.readFile(reasonPath, 'utf-8');
      return JSON.parse(data) as DeadLetter;
    } catch {
      return null;
    }
  }

  // --- Private Helpers ---

  /**
   * Resolve the base directory for an endpoint's Maildir.
   *
   * @param endpointHash - The hash identifying the endpoint.
   */
  private endpointDir(endpointHash: string): string {
    return path.join(this.rootDir, endpointHash);
  }

  /**
   * List message IDs in a given Maildir subdirectory.
   *
   * Filters to `.json` files only (excluding `.reason.json` sidecars)
   * and strips extensions to return bare ULID message IDs.
   *
   * @param endpointHash - The hash identifying the endpoint.
   * @param subdir - The subdirectory to list.
   */
  private async listSubdir(endpointHash: string, subdir: MaildirSubdir): Promise<string[]> {
    const dirPath = path.join(this.endpointDir(endpointHash), subdir);

    try {
      const entries = await fs.readdir(dirPath);
      return entries
        .filter((f) => f.endsWith(FILE_EXT) && !f.endsWith('.reason.json'))
        .map((f) => f.slice(0, -FILE_EXT.length))
        .sort();
    } catch (err) {
      // Directory doesn't exist yet — return empty list
      if (isEnoent(err)) {
        return [];
      }
      throw err;
    }
  }
}

// === File Helpers ===

/**
 * Write a file using O_CREAT | O_EXCL flags to prevent overwrites.
 *
 * @param filePath - Absolute path to write.
 * @param data - String content to write.
 */
async function writeFileExclusive(filePath: string, data: string): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    FILE_MODE
  );
  try {
    await handle.writeFile(data, 'utf-8');
  } finally {
    await handle.close();
  }
}

/**
 * Unlink a file, silently ignoring ENOENT errors.
 *
 * @param filePath - Absolute path to unlink.
 */
async function silentUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore — file may not exist
  }
}

/**
 * Check if an error is an ENOENT (file/directory not found) error.
 *
 * @param err - The error to check.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
