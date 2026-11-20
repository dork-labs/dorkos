/**
 * The owner's second factors on disk (DOR-3647; table `owner_factors`).
 *
 * An authenticator's shared secret is sealed with AES-256-GCM under a key
 * derived from the server's session-signing secret, so a copy of the database
 * alone does not hold a working secret. A passkey keeps only public material.
 *
 * Every write here is behind a person bar its route applies; nothing here
 * checks who is asking.
 *
 * @module services/core/auth/factors/owner-factors
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';
import { and, eq, gte, isNotNull, isNull, or, ownerFactors, type Db } from '@dorkos/db';

import { getAuth, readAuthDb } from '../index.js';

/** One factor, as routes and the sign-in checks read it. Never the secret itself. */
export type OwnerFactorRow = typeof ownerFactors.$inferSelect;

/** What the app shows about one factor. */
export interface OwnerFactorView {
  readonly id: string;
  readonly kind: 'totp' | 'passkey';
  readonly label: string;
  /** Passkeys only: the address it works on. */
  readonly host?: string;
  readonly addedAt: string;
  readonly lastUsedAt?: string;
}

const SEAL_LABEL = 'dorkos-owner-factor-seal:v1';

/** The sealing key, or `null` before auth is initialized. */
async function sealKey(): Promise<Buffer | null> {
  const auth = getAuth();
  if (!auth) return null;
  const secret = (await auth.$context).secret;
  return createHmac('sha256', secret).update(SEAL_LABEL).digest();
}

/**
 * Seal an authenticator secret for storage.
 *
 * @param plain - The base32 secret.
 * @throws When auth is not initialized.
 */
export async function sealSecret(plain: string): Promise<string> {
  const key = await sealKey();
  if (!key) throw new Error('Sign-in is not set up.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

/**
 * Open a sealed secret, or `null` when it cannot be opened (another key, damage).
 *
 * @param sealed - What {@link sealSecret} returned.
 */
export async function openSecret(sealed: string): Promise<string | null> {
  const key = await sealKey();
  const parts = sealed.split('.');
  if (!key || parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url')) as [
      Buffer,
      Buffer,
      Buffer,
    ];
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The database, or a refusal to work without one. */
function db(): Db {
  const found = readAuthDb();
  if (!found) throw new Error('Sign-in is not set up.');
  return found;
}

/**
 * A person's factors that count (confirmed, not removed), optionally of one kind.
 *
 * @param userId - Whose.
 * @param kind - Only this kind, when given.
 */
export function confirmedFactors(userId: string, kind?: 'totp' | 'passkey'): OwnerFactorRow[] {
  return everConfirmedFactors(userId, kind).filter((row) => row.removedAt === null);
}

/**
 * Every factor a person ever confirmed, removed ones included, optionally of
 * one kind: once one has existed, a password alone never signs them in from
 * another device again.
 *
 * @param userId - Whose.
 * @param kind - Only this kind, when given.
 */
export function everConfirmedFactors(userId: string, kind?: 'totp' | 'passkey'): OwnerFactorRow[] {
  const found = readAuthDb();
  if (!found) return [];
  return found
    .select()
    .from(ownerFactors)
    .where(
      and(
        eq(ownerFactors.userId, userId),
        isNotNull(ownerFactors.confirmedAt),
        ...(kind ? [eq(ownerFactors.kind, kind)] : [])
      )
    )
    .all();
}

/**
 * Whether a person has set up any second factor, so a password alone no
 * longer signs them in from another device.
 *
 * @param userId - Whose.
 */
export function hasSecondFactor(userId: string): boolean {
  return confirmedFactors(userId).length > 0;
}

/**
 * The factors as the app lists them.
 *
 * @param userId - Whose.
 */
export function listOwnerFactors(userId: string): OwnerFactorView[] {
  return confirmedFactors(userId).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    ...(row.rpId ? { host: row.rpId } : {}),
    addedAt: row.createdAt.toISOString(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  }));
}

/**
 * Store an authenticator secret not yet confirmed, replacing any other
 * unconfirmed one of the person's.
 *
 * @param userId - Whose.
 * @param label - What to call it.
 * @param secret - The base32 secret.
 * @returns The new factor's id.
 */
export async function addPendingTotp(
  userId: string,
  label: string,
  secret: string
): Promise<string> {
  const sealedSecret = await sealSecret(secret);
  const id = ulid();
  const store = db();
  store.transaction((tx) => {
    tx.delete(ownerFactors)
      .where(
        and(
          eq(ownerFactors.userId, userId),
          eq(ownerFactors.kind, 'totp'),
          isNull(ownerFactors.confirmedAt)
        )
      )
      .run();
    tx.insert(ownerFactors).values({ id, userId, kind: 'totp', label, sealedSecret }).run();
  });
  return id;
}

/**
 * One of a person's factors by id, confirmed or not, never a removed one.
 *
 * @param userId - Whose.
 * @param id - The factor id.
 */
export function findOwnerFactor(userId: string, id: string): OwnerFactorRow | undefined {
  return db()
    .select()
    .from(ownerFactors)
    .where(
      and(eq(ownerFactors.userId, userId), eq(ownerFactors.id, id), isNull(ownerFactors.removedAt))
    )
    .get();
}

/**
 * Mark an authenticator confirmed, recording the step its first code used.
 *
 * @param id - The factor id.
 * @param step - The step the confirming code matched.
 * @param now - The current time, for tests.
 */
export function confirmTotp(id: string, step: number, now = Date.now()): void {
  db()
    .update(ownerFactors)
    .set({ confirmedAt: new Date(now), lastStep: step })
    .where(
      and(eq(ownerFactors.id, id), isNull(ownerFactors.confirmedAt), isNull(ownerFactors.removedAt))
    )
    .run();
}

/**
 * Record a used authenticator step, only if it is newer than the last: a code
 * can never be used twice, even by two requests at once.
 *
 * @param id - The factor id.
 * @param step - The step the code matched.
 * @param now - The current time, for tests.
 * @returns Whether this use was the first for that step.
 */
export function useTotpStep(id: string, step: number, now = Date.now()): boolean {
  const row = db().select().from(ownerFactors).where(eq(ownerFactors.id, id)).get();
  if (!row || (row.lastStep !== null && row.lastStep >= step)) return false;
  const result = db()
    .update(ownerFactors)
    .set({ lastStep: step, lastUsedAt: new Date(now) })
    .where(
      and(
        eq(ownerFactors.id, id),
        row.lastStep === null
          ? isNull(ownerFactors.lastStep)
          : eq(ownerFactors.lastStep, row.lastStep)
      )
    )
    .run();
  return result.changes > 0;
}

/** A new passkey to store. */
export interface NewPasskey {
  readonly userId: string;
  readonly label: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly alg: number;
  readonly signCount: number;
  readonly rpId: string;
}

/**
 * Store a passkey; it counts at once.
 *
 * @param passkey - See {@link NewPasskey}.
 * @param now - The current time, for tests.
 * @returns The new factor's id.
 */
export function addPasskey(passkey: NewPasskey, now = Date.now()): string {
  const id = ulid();
  db()
    .insert(ownerFactors)
    .values({ id, kind: 'passkey', confirmedAt: new Date(now), ...passkey })
    .run();
  return id;
}

/**
 * A passkey that still counts, by its credential id.
 *
 * @param credentialId - Base64url.
 */
export function findPasskey(credentialId: string): OwnerFactorRow | undefined {
  return db()
    .select()
    .from(ownerFactors)
    .where(
      and(
        eq(ownerFactors.kind, 'passkey'),
        eq(ownerFactors.credentialId, credentialId),
        isNull(ownerFactors.removedAt)
      )
    )
    .get();
}

/**
 * Record a passkey's use and its new signature counter.
 *
 * @param id - The factor id.
 * @param previous - The counter the check read before it.
 * @param signCount - The counter the authenticator reported.
 * @param now - The current time, for tests.
 * @returns Whether this use was recorded; `false` when another use got there first.
 */
export function usePasskey(
  id: string,
  previous: number,
  signCount: number,
  now = Date.now()
): boolean {
  // Only if the counter is still the one this check read, so two checks at
  // once cannot both pass on it.
  const result = db()
    .update(ownerFactors)
    .set({ signCount, lastUsedAt: new Date(now) })
    .where(and(eq(ownerFactors.id, id), eq(ownerFactors.signCount, previous)))
    .run();
  return result.changes > 0;
}

/**
 * Remove one of a person's factors. It stops counting at once and is kept,
 * marked removed (see {@link everConfirmedFactors}).
 *
 * @param userId - Whose.
 * @param id - The factor id.
 * @param now - The current time, for tests.
 * @returns Whether one was removed.
 */
export function removeOwnerFactor(userId: string, id: string, now = Date.now()): boolean {
  return (
    db()
      .update(ownerFactors)
      .set({ removedAt: new Date(now) })
      .where(
        and(
          eq(ownerFactors.userId, userId),
          eq(ownerFactors.id, id),
          isNull(ownerFactors.removedAt)
        )
      )
      .run().changes > 0
  );
}

/**
 * Take back a factor whose add did not finish. Unlike
 * {@link removeOwnerFactor}, nothing is kept: it never counted, so it is not
 * one the person once had. Only a row still waiting, or confirmed at or after
 * `since`, and never removed, is taken: an older factor's history stays.
 *
 * @param userId - Whose.
 * @param id - The factor id.
 * @param since - When the request that added it began.
 */
export function discardOwnerFactor(userId: string, id: string, since: number): void {
  db()
    .delete(ownerFactors)
    .where(
      and(
        eq(ownerFactors.userId, userId),
        eq(ownerFactors.id, id),
        isNull(ownerFactors.removedAt),
        or(isNull(ownerFactors.confirmedAt), gte(ownerFactors.confirmedAt, new Date(since)))
      )
    )
    .run();
}
