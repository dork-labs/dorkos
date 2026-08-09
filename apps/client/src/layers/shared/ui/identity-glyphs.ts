/**
 * The marks the cockpit draws identities with — one registry, so two surfaces
 * cannot end up disagreeing about what an agent looks like.
 *
 * The Bot glyph used to be imported straight from `lucide-react` in two places
 * that mean the same thing by it — the badge in an avatar's corner and the mark
 * beside a session row — and the platform logos in one of those two. Nothing
 * connected them, so changing the agent mark meant knowing to change it twice.
 *
 * @module shared/ui/identity-glyphs
 */
import type { ComponentType } from 'react';
import { ADAPTER_LOGO_MAP, type AdapterLogoProps } from '@dorkos/icons/adapter-logos';
import { ArrowLeftRight, Bot, CalendarClock, Hash, Send } from 'lucide-react';

/**
 * What every glyph in this registry accepts — a pixel size and a class string.
 *
 * The intersection of what lucide's icons and this repo's own brand marks both
 * take, which is what lets one registry hand either kind to either caller.
 */
export type IdentityGlyph = ComponentType<AdapterLogoProps>;

/**
 * The mark an agent wears: the same Bot in the corner of its disc and beside a
 * session it started.
 *
 * One constant rather than two imports of the same icon, because "the agent
 * mark" is a product decision and `lucide-react` is a package. Changing it is
 * an edit here, not a search.
 */
export const AGENT_GLYPH: IdentityGlyph = Bot;

/**
 * The mark a person bridged in from another platform wears — that platform's
 * own logo, or a generic Send for a platform this build has no logo for.
 *
 * The fallback is deliberate and is not "nothing": somebody writing in from
 * elsewhere has to read as not-from-here even when the brand mark is missing,
 * because the alternative is a bridged person drawn exactly like a local one.
 *
 * @param platform - The platform id carried on the identity's origin.
 */
export function platformGlyph(platform: string): IdentityGlyph {
  return ADAPTER_LOGO_MAP[platform] ?? Send;
}

/**
 * Where a session came from, as one small mark.
 *
 * **`user` is deliberately absent, and its absence is the signal.** A
 * conversation you had with an agent is the ordinary case, and marking the
 * ordinary case would leave nothing for the marks to mean. Unmarked is you;
 * marked is something that happened without you.
 *
 * One registry so Today, the session switcher, "+N automated", ⌘K and Activity
 * cannot drift apart about what a scheduled run looks like (BC-26). It is the
 * key set of `ORIGIN_DESCRIPTORS` in `entities/session`, which pairs each glyph
 * with its label and is what the row-level `SessionOriginMark` renders; this is
 * the glyph half on its own, in `shared/`, for surfaces that have an origin
 * string and no session entity to hand.
 *
 * The mark rides in the row's TRAILING slot and never on the avatar — the
 * avatar's corners belong to identity (design-decisions §6).
 */
export const ORIGIN_GLYPH: Record<string, IdentityGlyph> = {
  /** Arrows: one agent calling another. */
  agent: ArrowLeftRight,
  /** Paper plane: a bridged conversation — Telegram, Slack, anything that wrote in from elsewhere. */
  channel: Send,
  /** Paper plane again: `external` is the same fact — it started outside this cockpit. */
  external: Send,
  /** `#`: a turn an agent took in one of this machine's own rooms, wearing the room's own mark. */
  room: Hash,
  /** Timer: a scheduled task that ran on its own clock. */
  task: CalendarClock,
};
