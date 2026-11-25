/**
 * Generic runtime-binary resolver shared across agent adapters.
 *
 * Every runtime resolves its executable from the same ordered set of sources —
 * an explicitly configured `binaryPath` (authoritative), an SDK-vendored or
 * on-demand-provisioned binary, then a `PATH` lookup — differing only in which
 * candidates they supply. This module owns the ordering, the existence checks,
 * and the "a configured path that is set-but-absent means MISSING, never fall
 * through" rule (ADR-0316, refined: a configured override wins over the vendored
 * default). It imports no runtime SDK, so ESLint's per-adapter SDK confinement
 * never applies to it and every adapter can share one resolution rule.
 *
 * @module services/runtimes/shared/resolve-binary
 */
import { existsSync } from 'node:fs';

/**
 * Produces a candidate binary path (existence-agnostic), or `null` when this
 * source has nothing to offer. May shell out (e.g. a `PATH` lookup), so it is
 * async-capable.
 */
export type BinaryCandidateProducer = () => string | null | Promise<string | null>;

/** One ordered source in a runtime's binary-resolution chain. */
export interface BinaryCandidate {
  /** Produce this source's candidate path, or `null` when it cannot. */
  resolve: BinaryCandidateProducer;
  /**
   * When true, a produced path is authoritative: if it exists it is used, and if
   * it is set-but-absent, resolution STOPS and reports the binary missing rather
   * than probing later sources. Use for a user-chosen `binaryPath` — we never
   * silently substitute a different binary the user did not select.
   */
  authoritative?: boolean;
  /**
   * When true, the producer already confirmed its path exists (because it looks
   * in several places, or checks more than existence), so it is used as given.
   */
  verified?: boolean;
}

/** A {@link BinaryCandidate} whose producer answers without awaiting anything. */
export interface SyncBinaryCandidate extends BinaryCandidate {
  /** Produce this source's candidate path, or `null` when it cannot. */
  resolve: () => string | null;
}

/**
 * Resolve the first existing binary from an ordered candidate list.
 *
 * Each candidate's producer runs in order and its produced path is
 * existence-checked. The first candidate whose path exists wins. A candidate
 * that produces `null`, or a non-authoritative candidate whose path does not
 * exist, is skipped so the next source is tried. An
 * {@link BinaryCandidate.authoritative} candidate whose produced path does not
 * exist short-circuits to `null` (report missing) instead of falling through —
 * preserving the honesty that a configured-but-absent path is a resolution miss,
 * not a reason to probe `PATH`.
 *
 * @param candidates - Ordered resolution sources, highest precedence first.
 * @returns The first existing binary path, or `null` when none resolves.
 */
export async function resolveRuntimeBinary(candidates: BinaryCandidate[]): Promise<string | null> {
  for (const candidate of candidates) {
    const decided = decide(candidate, await candidate.resolve());
    if (decided !== undefined) return decided;
  }
  return null;
}

/**
 * {@link resolveRuntimeBinary} for a ladder whose every rung answers
 * synchronously — the same order, existence checks and authoritative rule, for
 * callers that cannot await (a constructor, a sync route).
 *
 * @param candidates - Ordered resolution sources, highest precedence first.
 * @returns The first existing binary path, or `null` when none resolves.
 */
export function resolveRuntimeBinarySync(candidates: SyncBinaryCandidate[]): string | null {
  for (const candidate of candidates) {
    const decided = decide(candidate, candidate.resolve());
    if (decided !== undefined) return decided;
  }
  return null;
}

/** One rung's verdict: a path to use, `null` to stop (report missing), `undefined` to go on. */
function decide(candidate: BinaryCandidate, produced: string | null): string | null | undefined {
  if (produced == null) return undefined;
  if (candidate.verified || existsSync(produced)) return produced;
  // A set-but-absent authoritative path is an honest miss — never fall through.
  return candidate.authoritative ? null : undefined;
}
