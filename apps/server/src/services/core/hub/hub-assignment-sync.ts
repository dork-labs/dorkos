/**
 * A hub reads who it belongs to from DorkOS Cloud, and serves only them
 * (DOR-2934, ADR 261015-042933 §2.1).
 *
 * One read of `GET /v1/hubs/self/assignment` decides what happens:
 *
 * - **pooled** — nobody owns this hub yet. It refuses every request but the
 *   health check, and reads again later. An answer this release does not
 *   understand counts as pooled too, as the contract says: the hub stops
 *   serving until a later read makes sense again.
 * - **assigned, first time** — it pins the owner's account id and issuer to
 *   disk, creates the owner account (no password, no session) through the one
 *   caller the registration policy lets in on a hub (`provisioning`), keeps the address and front-door
 *   proof in memory, confirms the assignment, and starts serving. A hub that
 *   already holds an account but no pin is not a fresh one, and refuses.
 * - **assigned, same owner** — the address, proof or sign-in client may have
 *   changed; it takes the new keys and confirms again.
 * - **assigned, a different owner or issuer** — a fault. The owner never
 *   changes once confirmed, so it refuses and stops serving for good. It
 *   never serves a new owner from the old owner's data.
 * - **not_found after an owner was pinned** — the assignment ended; it stops
 *   serving for good.
 *
 * A failed request changes nothing: a hub that was serving keeps serving, and
 * one that was not keeps refusing. The owner is
 * matched by account id at one issuer, never by email.
 *
 * @module services/core/hub/hub-assignment-sync
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  HubAssignmentConfirmResponseSchema,
  HubAssignmentSchema,
  V1_ROUTES,
} from '@dork-labs/cloud-api';

import { CloudApiProblemError } from '@dork-labs/cloud-api/client';
import { z } from 'zod';

import { logger } from '../../../lib/logger.js';
import { setHubServingState, type LiveHubAssignment } from './hub-serving.js';

/** The owner a hub pinned when it first confirmed an assignment. */
export interface PinnedHubOwner {
  /** The owner's account id at {@link PinnedHubOwner.issuer}. */
  ownerAccountId: string;
  /** The one issuer whose sign-ins this hub accepts. */
  issuer: string;
  /** When the pin was written (ISO 8601). */
  pinnedAt: string;
}

/** What one sync did, for the caller's next wait and for tests. */
export type HubSyncOutcome =
  | { kind: 'pooled'; pollAfterSeconds: number | null }
  | { kind: 'serving'; assignmentId: string }
  | { kind: 'refused' }
  | { kind: 'ended' }
  | { kind: 'unchanged'; reason: 'unlinked' | 'unreadable' | 'failed' };

/** What a sync needs from the rest of the server. */
export interface HubAssignmentSyncDeps {
  /**
   * Read the assignment, unchecked; `null` when this hub holds no Cloud
   * credential. The sync checks the answer, so one it does not understand is
   * treated as the contract says rather than as a failed request.
   */
  readAssignment: () => Promise<unknown>;
  /** Confirm the assignment the hub now serves with. */
  confirm: (assignmentId: string) => Promise<void>;
  /** Whether the owner account exists yet. */
  ownerExists: () => boolean;
  /** Create the owner account. Runs only while none exists. */
  createOwner: (input: { email: string; name: string }) => Promise<void>;
  /** The pinned owner, or `null` before the first assignment. */
  readPin: () => PinnedHubOwner | null;
  /** Persist the pinned owner. */
  writePin: (pin: PinnedHubOwner) => void;
  /** The current time. */
  now?: () => Date;
}

/** The file a hub pins its owner in, under the data directory. */
export const HUB_OWNER_PIN_FILE = 'hub-owner.json';

/**
 * Read the pinned owner from `<dorkHome>/hub-owner.json`, or `null` when there
 * is none. A file that does not parse counts as a pin that cannot be trusted:
 * it throws, and the hub keeps refusing rather than taking a new owner.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function readHubOwnerPin(dorkHome: string): PinnedHubOwner | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dorkHome, HUB_OWNER_PIN_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<PinnedHubOwner>;
  if (typeof parsed.ownerAccountId !== 'string' || typeof parsed.issuer !== 'string') {
    throw new Error('The pinned hub owner file is not readable.');
  }
  return {
    ownerAccountId: parsed.ownerAccountId,
    issuer: parsed.issuer,
    pinnedAt: String(parsed.pinnedAt),
  };
}

/**
 * Write the pinned owner to `<dorkHome>/hub-owner.json`, readable only by this
 * user. It holds no secret, but nothing else has a reason to read it. The
 * write is atomic: a crash part-way leaves no pin rather than a torn one,
 * which would lock the hub out for good.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param pin - The owner to pin.
 */
export function writeHubOwnerPin(dorkHome: string, pin: PinnedHubOwner): void {
  fs.mkdirSync(dorkHome, { recursive: true });
  const file = path.join(dorkHome, HUB_OWNER_PIN_FILE);
  const partial = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(partial, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(pin, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(partial, file);
}

/**
 * The owner account's email. Never used to match the owner, who is matched by
 * account id at one issuer; it is only the identifier the local account store
 * requires, on the hub's own address so it can never be anybody's mailbox.
 *
 * @param assignment - The assignment being taken.
 */
export function hubOwnerEmail(assignment: LiveHubAssignment): string {
  return `owner@${new URL(assignment.address).hostname}`;
}

/**
 * Read the assignment once and act on it. See the module doc for each case.
 *
 * @param deps - See {@link HubAssignmentSyncDeps}.
 */
export async function syncHubAssignment(deps: HubAssignmentSyncDeps): Promise<HubSyncOutcome> {
  let pin: PinnedHubOwner | null;
  try {
    pin = deps.readPin();
  } catch (err) {
    logger.error('[Hub] The pinned owner cannot be read; this hub will not serve', {
      error: (err as Error).message,
    });
    setHubServingState({ state: 'refused' });
    return { kind: 'refused' };
  }

  let read: unknown;
  try {
    read = await deps.readAssignment();
  } catch (err) {
    if (err instanceof CloudApiProblemError && err.problem.code === 'not_found' && pin) {
      logger.warn('[Hub] DorkOS Cloud ended this hub`s assignment; it stops serving');
      setHubServingState({ state: 'ended' });
      return { kind: 'ended' };
    }
    logger.warn('[Hub] Could not read this hub`s assignment; nothing changes', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { kind: 'unchanged', reason: 'failed' };
  }
  if (read === null) return { kind: 'unchanged', reason: 'unlinked' };

  const parsed = HubAssignmentSchema.safeParse(read);
  if (!parsed.success) {
    // A state a later Cloud added, or a broken answer. The contract says act as
    // pooled: stop serving, and read again soon.
    logger.warn('[Hub] Could not understand this hub`s assignment; it stops serving for now');
    setHubServingState({ state: 'pooled' });
    return { kind: 'unchanged', reason: 'unreadable' };
  }
  const assignment = parsed.data;

  if (assignment.state === 'pooled') {
    if (pin) {
      // An owner was pinned, so this hub was assigned. Pooled again would hand
      // the old owner's data to whoever is assigned next.
      logger.error('[Hub] DorkOS Cloud reports this assigned hub as pooled; it will not serve');
      setHubServingState({ state: 'refused' });
      return { kind: 'refused' };
    }
    setHubServingState({ state: 'pooled' });
    return { kind: 'pooled', pollAfterSeconds: assignment.pollAfterSeconds ?? null };
  }

  if (
    pin &&
    (pin.ownerAccountId !== assignment.ownerAccountId || pin.issuer !== assignment.issuer)
  ) {
    logger.error('[Hub] DorkOS Cloud named a different owner for this hub; it will not serve');
    setHubServingState({ state: 'refused' });
    return { kind: 'refused' };
  }

  // The pin goes first: from here on this hub is this person's, whatever
  // fails next. A crash before the owner account exists leaves the pin, and
  // the next sync creates the account for the same owner.
  if (!pin && deps.ownerExists()) {
    logger.error('[Hub] This hub holds an account it did not pin; it will not serve');
    setHubServingState({ state: 'refused' });
    return { kind: 'refused' };
  }
  if (!pin) {
    deps.writePin({
      ownerAccountId: assignment.ownerAccountId,
      issuer: assignment.issuer,
      pinnedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  if (!deps.ownerExists()) {
    await deps.createOwner({ email: hubOwnerEmail(assignment), name: 'Owner' });
  }

  await deps.confirm(assignment.assignmentId);
  setHubServingState({ state: 'serving', assignment });
  return { kind: 'serving', assignmentId: assignment.assignmentId };
}

/**
 * The Cloud calls a hub makes, given a client bound to its instance key.
 *
 * @param client - The `/v1` client, or `null` when this hub holds no key.
 */
export function cloudHubCalls(
  client: {
    get: (path: string, schema: z.ZodUnknown) => Promise<unknown>;
    post: (
      path: string,
      schema: typeof HubAssignmentConfirmResponseSchema,
      init: { body: unknown }
    ) => Promise<unknown>;
  } | null
): Pick<HubAssignmentSyncDeps, 'readAssignment' | 'confirm'> {
  return {
    readAssignment: async () => (client ? client.get(V1_ROUTES.hubAssignment, z.unknown()) : null),
    confirm: async (assignmentId) => {
      if (!client) throw new Error('This hub holds no DorkOS Cloud credential.');
      await client.post(V1_ROUTES.hubAssignmentConfirm, HubAssignmentConfirmResponseSchema, {
        body: { assignmentId },
      });
    },
  };
}
