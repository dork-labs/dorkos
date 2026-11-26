import { CommandPaletteTrigger } from '@/layers/features/top-nav';
import { RightPanelToggle } from '@/layers/features/right-panel';
import { InboxBell } from '@/layers/widgets/inbox-bell';

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
 * It lives in the app layer, not beside `OneBar` in `widgets/one-bar`, because
 * the inbox bell is a widget of its own and a widget never imports another one
 * (DOR-4935). Putting widgets side by side is the shell's job, and the shell is
 * the only thing that mounts this.
 *
 * `shrink-0`, so a long room name eats the identity zone and never the controls.
 */
export function BarFixedCluster() {
  return (
    // `data-slot` so the ordering invariant (I1) is targetable by name: a test
    // or a browser check asks this element for its children rather than
    // guessing at the header's last div.
    // 4px gaps below `lg`, like the rest of the header row (DOR-2524).
    <div data-slot="bar-fixed-cluster" className="flex shrink-0 items-center gap-1 lg:gap-2">
      <CommandPaletteTrigger />
      <InboxBell />
      <RightPanelToggle />
    </div>
  );
}
