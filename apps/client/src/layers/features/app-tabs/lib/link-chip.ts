/**
 * What a chip for a link to a chat, channel or DM says (DOR-2824).
 *
 * A link an agent writes, `[Fix the login bug](/session?session=…)`, draws as
 * a small chip: the page's icon, its name and its live status. The chip names
 * the page exactly as its tab would, so it reads a {@link TabIdentity} from the
 * one builder in `tab-identity.ts` and only decides which half of it to show.
 * Pure functions only: `model/use-link-chip.ts` gathers, `ui/LinkChip.tsx` draws.
 *
 * @module features/app-tabs/lib/link-chip
 */
import { Hash, MessageSquare } from 'lucide-react';
import { tabAccessibleName, type TabIcon, type TabIdentity, type TabStatus } from './tab-identity';
import type { TabTarget } from './tab-target';

/** The pages a link chip can name. */
export type LinkChipKind = 'chat' | 'room';

/**
 * Where a chip is in finding its page: still `resolving`, `ready` with its
 * name, or `missing` because the page is gone or was never there.
 */
export type LinkChipState = 'resolving' | 'ready' | 'missing';

/**
 * Which kind of page a link points at, or `null` for one no chip names.
 *
 * A chat needs its id and a channel or DM its room id. A room in a connected
 * community stays a plain link: its name is read under that community's
 * access, which a link in a reply does not carry.
 *
 * @param target - The parsed link address.
 */
export function linkChipKind(target: TabTarget): LinkChipKind | null {
  if (target.settings || target.profile) return null;
  if (target.pathname === '/session') return target.sessionId && !target.draft ? 'chat' : null;
  if (target.pathname === '/channels') return target.roomId && !target.community ? 'room' : null;
  return null;
}

/** What a chip shows, worked out from the page's identity. */
export interface LinkChipFace {
  /** The glyph: the agent's emoji, a DM's face, `#` for a channel. */
  icon: TabIcon;
  /** The name to show, or `undefined` to keep the link's own words while resolving. */
  name?: string;
  /** The live status dot, when the page has one. */
  status?: TabStatus;
  /** The one sentence a pointer resting on the chip reads. */
  sentence?: string;
  /** What a screen reader announces, once the name is known. */
  accessibleName?: string;
  /** Whether the page is gone. */
  missing: boolean;
}

/** What a chip for a page that is gone says. */
export const LINK_CHIP_MISSING: Record<LinkChipKind, string> = {
  chat: 'Chat not found',
  room: 'Channel not found',
};

/**
 * What a chip shows for a page, in each state.
 *
 * - **ready:** a chat leads with its title, then falls back to its agent; a
 *   channel or DM is its name. The status and its sentence are the tab's.
 * - **resolving:** the icon, and the link's own words until the name arrives.
 * - **missing:** a plain "Chat not found" with no status.
 *
 * @param kind - Which kind of page the link points at.
 * @param identity - The page's tab identity.
 * @param state - Where the chip is in finding the page.
 */
export function linkChipFace(
  kind: LinkChipKind,
  identity: TabIdentity,
  state: LinkChipState
): LinkChipFace {
  if (state === 'missing') {
    const name = LINK_CHIP_MISSING[kind];
    return {
      icon: { kind: 'route', Icon: kind === 'chat' ? MessageSquare : Hash },
      name,
      accessibleName: name,
      missing: true,
    };
  }
  if (state === 'resolving') return { icon: identity.icon, missing: false };
  return {
    icon: identity.icon,
    name: kind === 'chat' ? identity.secondary || identity.primary : identity.primary,
    status: identity.status,
    sentence: identity.statusSentence,
    // The title leads the chip, so it leads what a screen reader hears too.
    accessibleName: tabAccessibleName(identity, { collapseAgent: kind === 'chat' }),
    missing: false,
  };
}
