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
import { Bot, Send } from 'lucide-react';

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
