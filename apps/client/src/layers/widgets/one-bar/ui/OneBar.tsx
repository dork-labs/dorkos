import type { ReactNode } from 'react';
import { CommandPaletteTrigger } from '@/layers/features/top-nav';
import { RightPanelToggle } from '@/layers/features/right-panel';
import { InboxBell } from '@/layers/widgets/inbox-bell';

interface OneBarProps {
  /** Who or what this page is: a title string, a tab strip, a room or session identity. */
  identity: ReactNode;
  /** State chips that describe the identity — working, archived, bridged, origin. */
  chips?: ReactNode;
  /** Page actions (New Agent, New Task). Rendered before the fixed cluster, never after it. */
  actions?: ReactNode;
}

/**
 * The one header row every route gets. Left to right:
 * `[identity] [chips] [flex space] [actions] [search · inbox · right panel]`.
 *
 * **The fixed cluster is rendered here, not by callers (I1).** Search, the
 * inbox bell and the right-panel toggle are always the last three controls, in
 * that order, on every route — so they are a property of the bar rather than a
 * thing each page remembers to append. A consumer has no slot after `actions`,
 * which is what makes "nothing ever renders between search and the right-panel
 * toggle" enforceable rather than aspirational. The cluster is `shrink-0`: a
 * long room name eats the identity zone, never the controls.
 *
 * **Truncation priority (I2).** The identity zone is `min-w-0` so its children
 * may shrink, and the title truncates with an ellipsis and keeps its full text
 * in a `title` attribute — `ChannelsHeader` feeds this user-controlled room
 * names (up to 200 chars, longer from a bridged Slack/Telegram room), and an
 * untruncated one blows the 36px row open on a phone. Chips sit outside that
 * shrinking region so state stays readable while the name gives ground; later
 * phases compress them to icons before the name is allowed to ellipsize.
 *
 * **No layout jump (I3).** Controls that come and go mid-run — a Stop button, a
 * "3 working" chip — must not shove the identity or the cluster sideways when
 * they appear. The pattern for that is reserved space, not conditional
 * rendering: keep the element mounted and animate or hide its contents (an
 * `aria-hidden` placeholder of the same width, or a `motion` width/opacity
 * transition), so the row's boxes are the same before and after. The cluster is
 * already immovable — it is `shrink-0` at the end of the row — so the rule
 * binds on whatever a route puts in `chips` and `actions`.
 *
 * **Window dragging (I5)** is handled by the `app-drag-region` class on the
 * shell's `<header>`, which this renders inside. Empty bar space drags the
 * window; every interactive descendant is opted back out by the blanket
 * `no-drag` rule in `index.css`, which covers buttons, links, inputs and
 * tooltip triggers. Anything interactive that is none of those shapes has to
 * say `-webkit-app-region: no-drag` for itself.
 */
export function OneBar({ identity, chips, actions }: OneBarProps) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">{identity}</div>
        {chips ? <div className="flex shrink-0 items-center gap-1.5">{chips}</div> : null}
      </div>
      {/* The fixed cluster. Order is the invariant: actions, then search, then
          the inbox, then the right-panel toggle — and nothing after. */}
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <CommandPaletteTrigger />
        <InboxBell />
        <RightPanelToggle />
      </div>
    </>
  );
}

interface BarTitleProps {
  /** The page's name, or a room's — possibly user-controlled and possibly long. */
  children: string;
}

/**
 * A title inside the identity zone: one line, ellipsized, full text on hover.
 *
 * Split out from {@link TitleBar} because bars with more identity than a string
 * — a room's `#name`, an agent's avatar and name — still want the same
 * truncation behavior for the name part.
 */
export function BarTitle({ children }: BarTitleProps) {
  return (
    <span className="min-w-0 truncate text-sm font-medium" title={children}>
      {children}
    </span>
  );
}
