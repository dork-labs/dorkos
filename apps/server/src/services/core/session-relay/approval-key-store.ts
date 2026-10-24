/**
 * The passkeys this computer accepts approvals from (spec `everything-is-a-space`
 * B4): `<data folder>/session-relay/approval-keys.json`, mode `0600`.
 *
 * Each key is pinned here when its owner adds it at this computer, never
 * fetched from the hub or DorkOS Cloud. The relying party (`rpId`) and the page
 * a proof must come from (`origin`) are pinned with the first key, so a proof
 * is checked against what was enrolled and never against anything a request
 * says. A separate file from the pin because each approval rewrites a key's
 * sign counter, and the pin should not be rewritten that often.
 *
 * A file that is missing, unreadable or does not parse reads as no keys, so
 * approvals from the web are refused (fail closed). Adding a key over a file
 * that is there but unreadable is refused too, never written over: the owner
 * removes it at this computer first. Removing the pin
 * (`clearRelayPin`) removes this file too. Every key added or removed is
 * written to the audit log by its id and label, never its key material.
 *
 * @module services/core/session-relay/approval-key-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STEP_UP_MAX_CREDENTIALS } from '@dork-labs/cloud-api';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { recordRelayAudit, type RelayAuditDeps } from './relay-audit.js';

/** The file, inside the relay's folder in the data folder. */
const KEYS_FILE = path.join('session-relay', 'approval-keys.json');
const FILE_MODE = 0o600;

/** Base64url text, unpadded, at most `max` characters. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** An https origin and nothing more, as `URL.origin` writes it. */
const HttpsOriginSchema = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value;
    } catch {
      return false;
    }
  }, 'must be a bare https origin');

/**
 * The COSE algorithms an approvals passkey may sign with: ES256 (-7), EdDSA
 * (-8) and RS256 (-257, Windows Hello). Anything else, RS1 (-65535) among
 * them, is refused when the key is added and when it is read back.
 */
export const APPROVAL_KEY_ALGS = [-7, -8, -257] as const;

/** One pinned approvals passkey. */
export const ApprovalKeySchema = z.strictObject({
  /** The WebAuthn credential id, base64url. */
  credentialId: base64url(1_400),
  /** The COSE public key, base64url. */
  cosePublicKey: base64url(2_048),
  /** The COSE algorithm the key signs with: ES256 (-7), EdDSA (-8) or RS256 (-257, Windows Hello). */
  alg: z.literal(APPROVAL_KEY_ALGS),
  /** The highest signature counter seen; 0 for a passkey that keeps none. */
  signCount: z.number().int().min(0).max(0xffffffff),
  /** What the owner called it, as Settings shows it. */
  label: z
    .string()
    .min(1)
    .max(64)
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    .regex(/^[^\u0000-\u001f\u007f]*$/),
  /** When it was added (ISO 8601). */
  addedAt: z.iso.datetime(),
});

/** See {@link ApprovalKeySchema}. */
export type ApprovalKey = z.infer<typeof ApprovalKeySchema>;

/** The whole file: the relying party the keys belong to, and the keys. */
export const ApprovalKeysSchema = z
  .strictObject({
    /** The file's own format. */
    v: z.literal(1),
    /** The WebAuthn relying party id, pinned with the first key. */
    rpId: z.string().min(1).max(253),
    /** The page every proof must come from, pinned with the first key. */
    origin: HttpsOriginSchema,
    /** The WebAuthn user handle every key was made for, base64url. */
    userHandle: base64url(128),
    /** The pinned keys. */
    keys: z.array(ApprovalKeySchema).max(STEP_UP_MAX_CREDENTIALS),
  })
  .refine((file) => new URL(file.origin).hostname === file.rpId, 'origin must be on rpId')
  .refine(
    (file) => new Set(file.keys.map((key) => key.credentialId)).size === file.keys.length,
    'a key may be pinned once'
  );

/** See {@link ApprovalKeysSchema}. */
export type ApprovalKeys = z.infer<typeof ApprovalKeysSchema>;

/** Where the relying party a new key belongs to is pinned. */
export type ApprovalRelyingParty = Pick<ApprovalKeys, 'rpId' | 'origin' | 'userHandle'>;

/** Why a key could not be added or removed, in a sentence for the owner. */
export class ApprovalKeyStoreError extends Error {
  /** Distinguishes this from a generic failure without an `instanceof` import. */
  override readonly name = 'ApprovalKeyStoreError';
}

/**
 * The file's path in a data folder.
 *
 * @param dorkHome - The data folder.
 */
export function approvalKeysPath(dorkHome: string): string {
  return path.join(dorkHome, KEYS_FILE);
}

/**
 * What is on disk: no file, a file that parses, a file that is there but does
 * not parse (`damaged`, which the owner may remove), or one that could not be
 * read just now (`error`: `EMFILE`, `EACCES`; never treated as damaged).
 */
type KeysOnDisk =
  | { state: 'missing' }
  | { state: 'ok'; keys: ApprovalKeys }
  | { state: 'damaged' }
  | { state: 'error' };

/** Read the file without deciding what an unreadable one means. */
function readKeysOnDisk(dorkHome: string): KeysOnDisk {
  let text: string;
  try {
    text = fs.readFileSync(approvalKeysPath(dorkHome), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    logger.warn(
      '[SessionRelay] The approval passkeys could not be read, so web approvals stay off'
    );
    return { state: 'error' };
  }
  try {
    const parsed = ApprovalKeysSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { state: 'ok', keys: parsed.data };
  } catch {
    // Falls through to the warning below.
  }
  logger.warn('[SessionRelay] The approval passkeys file is not valid, so web approvals stay off');
  return { state: 'damaged' };
}

/**
 * The pinned keys, or `null` when there are none. A file that cannot be read
 * or does not parse is `null` too, with a warning: approvals from the web are
 * then refused until the owner removes it at this computer and adds a key again.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function readApprovalKeys(dorkHome: string = resolveDorkHome()): ApprovalKeys | null {
  const disk = readKeysOnDisk(dorkHome);
  return disk.state === 'ok' && disk.keys.keys.length > 0 ? disk.keys : null;
}

/**
 * Whether the file is there but does not parse. Adding a key is refused then,
 * so a damaged file is never quietly replaced. A file that could not be read
 * just now is not damaged.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function approvalKeysUnreadable(dorkHome: string = resolveDorkHome()): boolean {
  return readKeysOnDisk(dorkHome).state === 'damaged';
}

/** The refusal for a keys file that could not be read just now. */
export const KEYS_READ_ERROR = 'Couldn’t read the passkeys file here. Try again.';

/** The refusal for adding a key to a link that is gone or changed. */
export const LINK_CHANGED_REFUSAL = 'This computer’s link changed. Start again in Settings.';

/** The refusal for adding a key over a file that cannot be read. */
export const UNREADABLE_KEYS_REFUSAL =
  'The passkeys file here is damaged. Remove it at this computer, then add a passkey.';

/**
 * Run a read-modify-write of the file, one at a time. `change` returns the
 * keys to write, or `undefined` to leave the file exactly as it is (so a
 * change that finds nothing to do never removes an unreadable file). With
 * `refuseUnreadable`, a file that cannot be read stops the change before it
 * starts, so it is never overwritten.
 */
function changeKeys(
  dorkHome: string,
  change: (current: ApprovalKeys | null) => ApprovalKeys | undefined,
  options: { refuseUnreadable?: boolean; stillLinked?: () => boolean } = {}
): Promise<ApprovalKeys | null> {
  const file = approvalKeysPath(dorkHome);
  return withFileLock(file, async (write) => {
    const disk = readKeysOnDisk(dorkHome);
    if (options.refuseUnreadable && disk.state === 'damaged') {
      throw new ApprovalKeyStoreError(UNREADABLE_KEYS_REFUSAL);
    }
    if (options.refuseUnreadable && disk.state === 'error') {
      throw new ApprovalKeyStoreError(KEYS_READ_ERROR);
    }
    // Read inside the lock, so an Unlink that clears the file waits behind this.
    if (options.stillLinked && !options.stillLinked()) {
      throw new ApprovalKeyStoreError(LINK_CHANGED_REFUSAL);
    }
    const current = disk.state === 'ok' && disk.keys.keys.length > 0 ? disk.keys : null;
    const next = change(current);
    if (next === undefined) return current;
    if (next.keys.length === 0) {
      fs.rmSync(file, { force: true });
      return null;
    }
    await write(JSON.stringify(ApprovalKeysSchema.parse(next)), { mode: FILE_MODE });
    return next;
  });
}

/**
 * Pin one approvals passkey. Only the owner's own enrolment at this computer
 * may call this (B4c). The first key pins the relying party; every later key
 * must belong to the same one.
 *
 * @param party - The relying party and user handle the key was made for.
 * @param key - The key; its sign counter starts where the enrolment left it.
 * @param audit - Who the audit log names, and its writer.
 * @param dorkHome - The data folder; defaults to the live one.
 * @param stillLinked - Re-reads the pin inside the keys file's lock: whether
 *   it is still the link the key was made for. Refused when not.
 * @returns The keys as now pinned.
 * @throws {@link ApprovalKeyStoreError} on a key already pinned, one too many,
 *   another relying party, or a keys file that is there but cannot be read
 *   (it is left exactly as it is; the owner removes it at this computer first).
 */
export async function addApprovalKey(
  party: ApprovalRelyingParty,
  key: ApprovalKey,
  audit: RelayAuditDeps,
  dorkHome: string = resolveDorkHome(),
  stillLinked?: () => boolean
): Promise<ApprovalKeys> {
  const checked = ApprovalKeySchema.parse(key);
  const next = await changeKeys(
    dorkHome,
    (current) => {
      const base = current ?? { v: 1 as const, ...party, keys: [] };
      if (
        base.rpId !== party.rpId ||
        base.origin !== party.origin ||
        base.userHandle !== party.userHandle
      ) {
        throw new ApprovalKeyStoreError('That passkey is for a different approve page.');
      }
      if (base.keys.some((pinned) => pinned.credentialId === checked.credentialId)) {
        throw new ApprovalKeyStoreError('That passkey is already added.');
      }
      if (base.keys.length >= STEP_UP_MAX_CREDENTIALS) {
        throw new ApprovalKeyStoreError('Remove a passkey before adding another.');
      }
      return { ...base, keys: [...base.keys, checked] };
    },
    { refuseUnreadable: true, ...(stillLinked ? { stillLinked } : {}) }
  );
  recordRelayAudit(audit, {
    action: 'relay.passkey.added',
    operation: 'create',
    outcome: 'ok',
    target: { type: 'passkey', id: checked.credentialId },
    change: [{ field: 'label', after: checked.label }],
    summary: 'Added a passkey for approvals from the web',
  });
  if (!next) throw new ApprovalKeyStoreError('That passkey could not be added.');
  return next;
}

/**
 * Unpin one approvals passkey. Removing the last one removes the file, so
 * approvals from the web stop at once.
 *
 * @param credentialId - The key to remove.
 * @param audit - Who the audit log names, and its writer.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns Whether a key was removed.
 */
export async function removeApprovalKey(
  credentialId: string,
  audit: RelayAuditDeps,
  dorkHome: string = resolveDorkHome()
): Promise<boolean> {
  let removed: ApprovalKey | undefined;
  await changeKeys(dorkHome, (current) => {
    removed = current?.keys.find((key) => key.credentialId === credentialId);
    if (!current || !removed) return undefined;
    return { ...current, keys: current.keys.filter((key) => key !== removed) };
  });
  if (!removed) return false;
  recordRelayAudit(audit, {
    action: 'relay.passkey.removed',
    operation: 'remove',
    outcome: 'ok',
    target: { type: 'passkey', id: removed.credentialId },
    change: [{ field: 'label', before: removed.label }],
    summary: 'Removed a passkey for approvals from the web',
  });
  return true;
}

/** What removing a damaged keys file came to. */
export type RemoveDamagedResult = 'removed' | 'not-damaged' | 'read-error';

/**
 * Remove a keys file that is there but does not parse, so the owner can add a
 * passkey again. A readable file is left alone (its keys are removed one at a
 * time), and so is one that could not be read just now. Audited.
 *
 * @param audit - Who the audit log names, and its writer.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns What happened.
 */
export async function removeDamagedApprovalKeys(
  audit: RelayAuditDeps,
  dorkHome: string = resolveDorkHome()
): Promise<RemoveDamagedResult> {
  const file = approvalKeysPath(dorkHome);
  const result = await withFileLock(file, async (): Promise<RemoveDamagedResult> => {
    const { state } = readKeysOnDisk(dorkHome);
    if (state === 'error') return 'read-error';
    if (state !== 'damaged') return 'not-damaged';
    fs.rmSync(file, { force: true });
    return 'removed';
  });
  if (result === 'removed') {
    recordRelayAudit(audit, {
      action: 'relay.passkey.removed-damaged',
      operation: 'remove',
      outcome: 'ok',
      target: { type: 'passkey', id: 'approval-keys-file' },
      summary: 'Removed a damaged passkeys file for approvals from the web',
    });
  }
  return result;
}

/**
 * Remove the keys file now, and again once every change already queued on it
 * has finished, so a key being written as the pin goes cannot outlive it.
 * Never throws.
 *
 * @param dorkHome - The data folder.
 */
export function removeApprovalKeysFile(dorkHome: string): void {
  const file = approvalKeysPath(dorkHome);
  fs.rmSync(file, { force: true });
  try {
    void withFileLock(file, async () => {
      fs.rmSync(file, { force: true });
    }).catch((error: unknown) => {
      logger.warn('[SessionRelay] Could not remove the approval passkeys file', {
        error: (error as Error).name,
      });
    });
  } catch {
    // Already inside this file's lock: the removal above is the whole of it.
  }
}

/**
 * Record the sign counter a passing proof carried, as a compare-and-set inside
 * the store's lock: it succeeds only while the key is still pinned and its
 * stored counter is still the one the proof was checked against. So a key
 * removed mid-check, or a second proof checked against the same counter,
 * never succeeds. A passkey that keeps no counter (stored 0, proof 0) records
 * nothing and succeeds; a counter that went backwards never does.
 *
 * @param credentialId - The key that signed.
 * @param expected - The stored counter the proof was checked against.
 * @param signCount - The counter its proof carried.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns Whether the proof may be acted on.
 */
export async function bumpSignCount(
  credentialId: string,
  expected: number,
  signCount: number,
  dorkHome: string = resolveDorkHome()
): Promise<boolean> {
  let recorded = false;
  await changeKeys(dorkHome, (current) => {
    const key = current?.keys.find((pinned) => pinned.credentialId === credentialId);
    if (!current || !key || key.signCount !== expected) return undefined;
    if (key.signCount === 0 && signCount === 0) {
      recorded = true;
      return undefined;
    }
    if (signCount <= key.signCount) return undefined;
    recorded = true;
    return {
      ...current,
      keys: current.keys.map((pinned) => (pinned === key ? { ...pinned, signCount } : pinned)),
    };
  });
  return recorded;
}
