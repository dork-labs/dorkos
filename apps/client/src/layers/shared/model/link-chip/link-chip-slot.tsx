/**
 * The slot through which a link to a chat, channel or DM in markdown draws as
 * a chip: the agent's icon, the chat's title and its live status (DOR-2824).
 *
 * `MarkdownLink` lives in `shared/ui` and draws every markdown link in the app,
 * but naming a page and reading its status is the tab strip's identity builder
 * (`features/app-tabs`, DOR-2820), which shared may not import. So the app
 * shell hands the chip down through this context, the same shape as the
 * credits offer slot. With no provider (a unit test, the Dev Playground) the
 * slot is `null` and every link stays a plain underlined link.
 *
 * The link keeps its own click rules: the slot draws what is inside the
 * anchor and wraps it, but `MarkdownLink` still owns the `<a>` and every
 * decision about where a click goes.
 *
 * @module shared/model/link-chip/link-chip-slot
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/** What a chip may set on the anchor `MarkdownLink` draws for it. */
export interface LinkChipAnchorProps {
  /** The chip's box. Replaces the plain link's underline styling. */
  className?: string;
  /** What a screen reader announces: the name, then the status in words. */
  'aria-label'?: string;
  /** Which state the chip is in, for tests and styling hooks. */
  'data-chip'?: string;
}

/** What `MarkdownLink` hands the chip. */
export interface LinkChipRenderProps {
  /** The app address the link points at, router-relative (`/session?session=…`). */
  address: string;
  /** The link's own words, shown until the chip knows the page's name. */
  label: ReactNode;
  /**
   * Draws the link itself around `content`. The chip calls it exactly once and
   * may wrap the result (a tooltip trigger); the click rules stay the link's.
   */
  anchor: (content: ReactNode, props?: LinkChipAnchorProps) => ReactElement;
}

/** What the app shell supplies. */
export interface LinkChipSlot {
  /** Whether an address is a page the chip can name (a chat, a channel, a DM). */
  accepts: (address: string) => boolean;
  /** Draws the chip. Called only for an address {@link LinkChipSlot.accepts}. */
  render: (props: LinkChipRenderProps) => ReactNode;
}

const LinkChipContext = createContext<LinkChipSlot | null>(null);

/**
 * Supply the link chip to everything below. Mounted once, by the app shell.
 *
 * @param props.slot - Decides which links become chips and draws them.
 * @param props.children - The app.
 */
export function LinkChipProvider({ slot, children }: { slot: LinkChipSlot; children: ReactNode }) {
  return <LinkChipContext.Provider value={slot}>{children}</LinkChipContext.Provider>;
}

/** The link chip the app shell supplied, or `null` where none was. */
export function useLinkChipSlot(): LinkChipSlot | null {
  return useContext(LinkChipContext);
}
