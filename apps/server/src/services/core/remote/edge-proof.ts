/**
 * The managed-edge proof check: did this request really come through the
 * DorkOS managed edge?
 *
 * The edge removes every copy of the proof header a client sent and adds
 * exactly one, carrying a per-credential secret (`RemoteEdgeProofSchema` in
 * `@dork-labs/cloud-api`). So a request on the managed ingress is accepted only
 * when it carries **exactly one** copy whose value matches, compared in
 * constant time. Zero copies, several copies, or a different value are refused
 * — never resolved by reading the first or last copy, which is what Node's
 * joined `req.headers` value would invite. That is why this reads `rawHeaders`.
 *
 * During a credential replacement the previous secret stays acceptable until a
 * deadline (at most `REMOTE_EDGE_PROOF_OVERLAP_SECONDS` after the new one was
 * confirmed), and never more than two secrets at once.
 *
 * Everything here is pure: the caller owns the clock and the request. The proof
 * says only that a request came through the edge. It is not a login, and it
 * never stands in for one.
 *
 * @module services/core/remote/edge-proof
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { REMOTE_EDGE_PROOF_OVERLAP_SECONDS, type RemoteEdgeProof } from '@dork-labs/cloud-api';

/** The previous proof, accepted until `acceptUntil` (epoch ms). */
interface PreviousEdgeProof {
  readonly proof: RemoteEdgeProof;
  readonly acceptUntil: number;
}

/** What the ingress checks against: the current proof and, briefly, the one it replaced. */
export interface EdgeProofState {
  readonly current: RemoteEdgeProof;
  readonly previous: PreviousEdgeProof | null;
}

/** Why a request's proof was refused. Safe to log: it never carries the secret. */
export type EdgeProofRefusal = 'missing' | 'duplicate' | 'mismatch';

/** The outcome of {@link checkEdgeProof}. */
export type EdgeProofCheck =
  | { readonly ok: true; readonly matched: 'current' | 'previous' }
  | { readonly ok: false; readonly reason: EdgeProofRefusal };

/**
 * Start a proof state from the first proof a credential delivered.
 *
 * @param proof - The edge proof issued with the credential.
 */
export function initialEdgeProofState(proof: RemoteEdgeProof): EdgeProofState {
  return { current: proof, previous: null };
}

/**
 * Move to a replacement proof, keeping the old one acceptable for the overlap
 * window. Replacing with the same header and secret changes nothing.
 *
 * Only the proof being replaced survives as `previous`: a third secret is never
 * accepted, so an older `previous` is dropped here even if its window had time
 * left.
 *
 * @param state - The current state, or `null` when there is none yet.
 * @param next - The proof delivered with the replacement credential.
 * @param confirmedAt - Epoch ms at which the replacement was confirmed; the
 *   old proof is accepted until this plus the overlap.
 */
export function rotateEdgeProofState(
  state: EdgeProofState | null,
  next: RemoteEdgeProof,
  confirmedAt: number
): EdgeProofState {
  if (!state) return initialEdgeProofState(next);
  if (sameProof(state.current, next)) return state;
  return {
    current: next,
    previous: {
      proof: state.current,
      acceptUntil: confirmedAt + REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000,
    },
  };
}

/**
 * Stop accepting the previous proof at once — what a revoke of the old
 * credential requires.
 *
 * @param state - The current state.
 */
export function dropPreviousEdgeProof(state: EdgeProofState): EdgeProofState {
  return state.previous ? { current: state.current, previous: null } : state;
}

/**
 * Check one request's proof header against the state.
 *
 * @param rawHeaders - The request's `rawHeaders` (alternating name, value), so
 *   every copy of the header is seen rather than Node's joined value.
 * @param state - The proof state to check against.
 * @param now - Epoch ms, for the previous proof's deadline.
 */
export function checkEdgeProof(
  rawHeaders: readonly string[],
  state: EdgeProofState,
  now: number
): EdgeProofCheck {
  const candidates = acceptedProofs(state, now);
  // Headers are compared without regard to case. The current and previous
  // proofs may name different headers, so every accepted header is counted.
  for (const { proof, matched } of candidates) {
    const values = headerValues(rawHeaders, proof.header);
    if (values.length === 0) continue;
    if (values.length > 1) return { ok: false, reason: 'duplicate' };
    if (constantTimeEquals(values[0]!, proof.secret)) return { ok: true, matched };
    // A single non-matching copy may still be the other accepted proof's
    // secret (the two usually share a header name), so keep looking.
  }
  const anyPresent = candidates.some(({ proof }) => headerValues(rawHeaders, proof.header).length);
  return { ok: false, reason: anyPresent ? 'mismatch' : 'missing' };
}

/**
 * Remove every copy of every proof header in the state from a request, so the
 * secret never reaches the app, its logs, or anything it forwards.
 *
 * Mutates `rawHeaders`, `headers` and `headersDistinct` in place. Node builds
 * the two parsed views from `rawHeaders` lazily, counting entries it recorded at
 * parse time, so both are materialized BEFORE `rawHeaders` shrinks: building one
 * afterwards would walk past the end of the shortened array.
 *
 * @param req - The request to strip.
 * @param req.rawHeaders - Alternating header names and values.
 * @param req.headers - The parsed header object.
 * @param req.headersDistinct - The parsed header object with every value kept, when present.
 * @param state - The state whose header names are removed.
 */
export function stripEdgeProofHeaders(
  req: {
    rawHeaders: string[];
    headers: Record<string, unknown>;
    headersDistinct?: Record<string, unknown>;
  },
  state: EdgeProofState
): void {
  const headers = req.headers;
  const distinct = req.headersDistinct;
  const names = new Set([
    state.current.header,
    ...(state.previous ? [state.previous.proof.header] : []),
  ]);
  for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
    if (names.has(req.rawHeaders[i]!.toLowerCase())) req.rawHeaders.splice(i, 2);
  }
  for (const name of names) {
    delete headers[name];
    if (distinct) delete distinct[name];
  }
}

/** The proofs accepted at `now`, current first. */
function acceptedProofs(
  state: EdgeProofState,
  now: number
): { proof: RemoteEdgeProof; matched: 'current' | 'previous' }[] {
  const accepted: { proof: RemoteEdgeProof; matched: 'current' | 'previous' }[] = [
    { proof: state.current, matched: 'current' },
  ];
  if (state.previous && now < state.previous.acceptUntil) {
    accepted.push({ proof: state.previous.proof, matched: 'previous' });
  }
  return accepted;
}

/** Every value carried under `name` (lower case), in order. */
function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === name) values.push(rawHeaders[i + 1]!);
  }
  return values;
}

/**
 * Constant-time string comparison. Both sides are hashed first so the compare
 * takes the same time whatever the lengths, and a length difference leaks
 * nothing either.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Whether two proofs are the same header and secret. */
function sameProof(a: RemoteEdgeProof, b: RemoteEdgeProof): boolean {
  return a.header === b.header && constantTimeEquals(a.secret, b.secret);
}
