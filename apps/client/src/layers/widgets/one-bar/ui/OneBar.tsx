import type { ReactNode } from 'react';
import { CommandPaletteTrigger } from '@/layers/features/top-nav';
import { RightPanelToggle } from '@/layers/features/right-panel';
import { InboxBell } from '@/layers/widgets/inbox-bell';

interface OneBarProps {
  /**
   * Who or what this page is: a title, a room's `#name`, an agent identity.
   * Rendered at its natural width — it does not grow.
   */
  identity: ReactNode;
  /**
   * Identity content that should absorb the leftover width: a filter bar, a tab
   * strip. It carries the `flex-1` basis-0, which is what keeps the title beside
   * it at its natural width — see the truncation note below.
   */
  fill?: ReactNode;
  /** State chips that describe the identity — working, archived, bridged, origin. */
  chips?: ReactNode;
  /** Page actions (New Agent, New Task), at the right edge before the fixed cluster. */
  actions?: ReactNode;
}

/**
 * The one header row every route gets:
 * `[identity] [chips] [fill / flex space] [actions]`, with the shell's
 * {@link BarFixedCluster} always after it.
 *
 * **Truncation priority (I2), and the one thing to get right here.** `identity`
 * and `fill` are direct flex children of the bar, not siblings inside a wrapper.
 * That distinction is load-bearing: when both sat in one `flex-1` wrapper as
 * plain auto-basis items, they shrank in proportion to their content, so the
 * `/activity` title collapsed to 0px and `/team` rendered as "Te…" at 390px.
 * Giving `fill` the `flex-1` basis-0 makes it the item that absorbs and yields
 * space, leaving the title at its natural width until nothing else is left —
 * at which point `min-w-0 truncate` ellipsizes it and the `title` attribute
 * keeps the full text reachable. Room names are user-controlled and arrive from
 * bridged Slack/Telegram rooms, so a title that cannot truncate blows the 36px
 * row open on a phone.
 *
 * **The fixed cluster is not here (I1).** Search, the inbox bell and the
 * right-panel toggle are rendered once by the shell, outside the cross-fade, so
 * they stay mounted while the bar under them changes — inside the keyed
 * `motion.div` they faded out and back on every navigation, which is a flicker
 * on the two controls that must always look reachable. The invariant survives
 * the move intact: the shell renders the route's bar and *then* the cluster, so
 * a route bar's entire output lands in the preceding sibling and no page can
 * put anything between search and the toggle. It is enforced by structure
 * either way; only the owner changed.
 *
 * **No layout jump (I3).** Controls that come and go mid-run — a Stop button, a
 * "3 working" chip — must not shove the identity or the cluster sideways when
 * they appear. The pattern for that is reserved space, not conditional
 * rendering: keep the element mounted and animate or hide its contents (an
 * `aria-hidden` placeholder of the same width, or a `motion` width/opacity
 * transition), so the row's boxes are the same before and after.
 *
 * **Window dragging (I5)** is handled by the `app-drag-region` class on the
 * shell's `<header>`, which this renders inside. Empty bar space drags the
 * window; every interactive descendant is opted back out by the blanket
 * `no-drag` rule in `index.css`, which covers buttons, links, inputs and
 * tooltip triggers. Anything interactive that is none of those shapes has to
 * say `-webkit-app-region: no-drag` for itself.
 */
export function OneBar({ identity, fill, chips, actions }: OneBarProps) {
  return (
    <>
      {identity}
      {chips ? <div className="flex shrink-0 items-center gap-1.5">{chips}</div> : null}
      {fill ? (
        // `self-stretch` passes the row's height through to fill content that
        // asks for it. Without it this wrapper is sized by its own content
        // rather than by the row, so `/team`'s tab strip — which sizes its tabs
        // with `h-full` — had nothing full-height to resolve against and its
        // tabs came out short of the row. Stretched, they measure 35px: the
        // 36px row less the 1px that is its bottom hairline. `items-center`
        // still centres children that do not ask to stretch, so filter chips
        // are unaffected.
        //
        // **A strip in `fill` is three wrappers deep, and every one of them has
        // to stretch.** The shell's cross-fade wrapper and `bar-tab-strip`'s own
        // wrapper are the other two; both got their `self-stretch` in DOR-1401,
        // and the 24px figures in their comments describe the DOM as it was
        // then, before the strip owned its stretch — they are not measurements
        // of this wrapper and do not predict what it does today. What carries
        // forward is only the structure: `h-full` means the row exactly when
        // nothing between the tab and the header caps the chain, so a fill
        // wrapper that stops stretching silently shortens the tabs again.
        <div className="ml-3 flex min-w-0 flex-1 items-center self-stretch">{fill}</div>
      ) : (
        <div className="flex-1" />
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
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

/**
 * Search, the inbox, and the right-panel toggle — the last three controls of
 * every bar, in that order, on every route (I1).
 *
 * Mounted once by the shell, as a sibling *after* the route bar's cross-fade.
 * Two things follow from that placement, and both are the point of it. The
 * controls do not animate when the route changes, so the corner a person reaches
 * for never blinks. And a route bar cannot render past them: its whole output is
 * confined to the preceding sibling, so "nothing ever renders between search and
 * the right-panel toggle" is a fact about the DOM rather than a rule each page
 * has to remember.
 *
 * `shrink-0`, so a long room name eats the identity zone and never the controls.
 */
export function BarFixedCluster() {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <CommandPaletteTrigger />
      <InboxBell />
      <RightPanelToggle />
    </div>
  );
}
