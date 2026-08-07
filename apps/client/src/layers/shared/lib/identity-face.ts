/**
 * One ladder for deciding what an identity's disc looks like.
 *
 * @module shared/lib/identity-face
 */
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import type { IdentityOrigin } from '../ui/identity-origin';
import { hashToHslColor } from './favicon-utils';
import { initialOf } from './initial-of';

/**
 * The record an identity is drawn from — its id, what it is, what it is
 * called, and whatever face the server last cached for it.
 *
 * Structurally an `AuthorRef` minus the fields a disc has no use for, so a
 * caller holding one passes it straight in. Deliberately not the `AuthorRef`
 * type itself: this resolver is also the one a surface with no room behind it
 * would use, and it should not need a room schema to say "id, kind, name".
 */
export interface IdentityRecord {
  /** The identity's opaque id. The fallback colour is hashed from it. */
  id: string;
  /** What this identity is. Passed through untouched — the disc reads it. */
  kind: AuthorKind;
  /** The name the fallback letter is taken from. */
  displayName: string;
  /** Render cache: the emoji the server last resolved, when there was one. */
  emoji?: string;
  /** Render cache: the colour the server last resolved, when there was one. */
  color?: string;
}

/**
 * A face from a fresher source than the record's cache — in practice an
 * agent's own manifest, which only a feature-layer caller can reach.
 *
 * Structural on purpose: it is what `resolveAgentVisual()` already returns, and
 * naming an agent type here would put this function out of reach of
 * `entities/room`, which is the one place that most needs it.
 */
export interface IdentityFaceOverride {
  /** The identity's colour, as its own source gives it. */
  color?: string;
  /** The identity's emoji, as its own source gives it. */
  emoji?: string;
}

/** The fragments a caller happens to hold about one identity. */
export interface IdentityFaceInput {
  /** The identity's record, cache and all. */
  record: IdentityRecord;
  /**
   * A face resolved from something fresher than the record. `null` and
   * `undefined` both mean "nothing fresher" — a caller that looked and found
   * none says the same thing as one that never looked.
   */
  override?: IdentityFaceOverride | null;
  /** Where a human is posting from, when the caller knows. Passed through. */
  origin?: IdentityOrigin;
}

/** Everything one identity disc needs, resolved once. */
export interface IdentityFace {
  /** What the identity is — the disc derives its shape, fill and badge from it. */
  kind: AuthorKind;
  /** The colour the disc paints itself with. Never empty. */
  color: string;
  /** The identity's emoji, when any source had one. */
  emoji?: string;
  /** The letter drawn when there is no emoji. */
  fallback: string;
  /** Where a human is posting from, when the caller knew. */
  origin?: IdentityOrigin;
}

/**
 * Resolve one identity's face from the fragments a caller happens to hold.
 *
 * Precedence, highest first: an explicit `override` (an agent's own manifest
 * colour/icon, which only a feature-layer caller can reach), then the record's
 * own render cache, then a colour hashed from the opaque id and the first
 * letter of the display name.
 *
 * The last rung hashes rather than going neutral, and hashes the same way
 * `resolveAgentVisual` does, so an identity nobody could resolve still reads as
 * the same one in every list it appears in. It stops short of hashing an
 * **emoji**: a letter is honestly "we don't know this one's face", where an
 * invented emoji is a confident-looking face matching nothing.
 *
 * Pure, layer-free and takes no agent types, which is the point: `MemberList`
 * lives in `entities/room` and may not import `entities/agent`, and that is
 * exactly why the two roster implementations diverged in the first place.
 *
 * @param input - The record, plus anything fresher the caller resolved.
 */
export function resolveIdentityFace(input: IdentityFaceInput): IdentityFace {
  const { record, override, origin } = input;
  return {
    kind: record.kind,
    color: override?.color ?? record.color ?? hashToHslColor(record.id),
    emoji: override?.emoji ?? record.emoji,
    fallback: initialOf(record.displayName),
    origin,
  };
}
