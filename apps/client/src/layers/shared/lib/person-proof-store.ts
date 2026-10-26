/**
 * The person proof this app page keeps after the owner's step-up (DOR-3330).
 *
 * Kept in this origin's own storage, never a cookie: a cookie reaches every
 * port on this computer, this storage reaches only this page's origin. Every
 * API call sends it, so at this computer the session stands for the person
 * only in this app.
 *
 * @module shared/lib/person-proof-store
 */
import { PERSON_PROOF_STORAGE_KEY } from '@dorkos/shared/person-session';

/** The proof this page holds, or `null`. */
export function readPersonProof(): string | null {
  try {
    return globalThis.localStorage?.getItem(PERSON_PROOF_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep the proof a step-up answered with.
 *
 * @param proof - The proof.
 */
export function writePersonProof(proof: string): void {
  try {
    globalThis.localStorage?.setItem(PERSON_PROOF_STORAGE_KEY, proof);
  } catch {
    // Storage refused (private mode, quota): the next person action asks again.
  }
}
