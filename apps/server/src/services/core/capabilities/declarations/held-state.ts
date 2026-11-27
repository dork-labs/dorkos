/**
 * Sealing server state a confirm-first hold binds (`ConfirmFirstSheet.heldState`,
 * DOR-4978): an HMAC under a per-process random key. Its own module, with no
 * capability imports, so the capability port can re-export it.
 *
 * @module services/core/capabilities/declarations/held-state
 */
import { createHmac, randomBytes } from 'node:crypto';

/** This process's key: held actions die with the process anyway. */
const HELD_STATE_KEY = randomBytes(32);

/**
 * Seal server state for a confirm-first hold, so the value bound into a hold
 * says nothing about the state it was read from, and only this process can
 * make one that matches.
 *
 * @param state - The state as read (a stored record's fingerprint).
 * @returns The keyed hash, base64url.
 */
export function sealHeldState(state: string): string {
  return createHmac('sha256', HELD_STATE_KEY).update(state).digest('base64url');
}
