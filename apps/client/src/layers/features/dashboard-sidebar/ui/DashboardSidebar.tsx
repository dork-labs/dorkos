/**
 * The sidebar body: a landmark, a drag layer, and the zones.
 *
 * It was 875 lines of rules in JSX. Everything it used to decide — which rows
 * appear, in what order, under what cap, with what badge — is now
 * `buildSidebarModel`, and this composes the three things a renderer needs: the
 * `<nav>` landmark, the drag layer, and `SidebarZones`.
 *
 * **It transforms nothing.** Not "holds no rules" as an aspiration — the source
 * contains no array method and reads no model field, and `DashboardSidebar.test.tsx`
 * scans it to make sure, with a case that watches the scan fail on rules put
 * back in. Anything that needs to filter, order, cap or count belongs in a rule
 * (`model/rules/`) or in the component that draws the thing it is about.
 *
 * The header block and the footer strip are NOT here: they are persistent
 * chrome mounted in `AppShell`, outside the `sidebar.body` swap region, so a
 * marketplace takeover replaces the body and leaves them standing (spec R2,
 * P2 AC-8). P2.4 and P2.5 fill those mount points.
 *
 * @module features/dashboard-sidebar/ui/DashboardSidebar
 */
import { SidebarContent } from '@/layers/shared/ui';
import { SidebarBottomSlot } from './bottom-slot/SidebarBottomSlot';
import { useBootState } from '../model/boot/use-boot-state';
import { useLegacyPinMigration } from '../model/use-legacy-pin-migration';
import { useSidebarModel } from '../model/use-sidebar-model';
import { useSidebarState } from '../model/use-sidebar-state';
import { SidebarChrome } from './SidebarChrome';
import { SidebarDnd } from './dnd/SidebarDnd';
import { SidebarZones } from './SidebarZones';

/**
 * The dashboard sidebar — Heads up, Today and Library, drawn from one model.
 *
 * Pins, channels, direct messages, agents and groups all stay exactly where
 * they were put: Library is the operator's own structure and nothing reorders
 * it (BC-28 → BC-33). Heads up and Today above it are computed, and are the only
 * parts of the panel that move on their own.
 */
export function DashboardSidebar() {
  useLegacyPinMigration();
  const state = useSidebarState();
  const model = useSidebarModel(state);
  const boot = useBootState();

  return (
    // The panel root is the sidebar's one landmark (R2). Zones are sections
    // inside it, each labelled by its own heading.
    //
    // `aria-busy` is the WHOLE announcement of a cold boot (spec D6): the
    // skeleton itself is `aria-hidden` and there is no live region reading out
    // bones, because "the sidebar is still loading" is a property of the
    // landmark and not an event worth interrupting anybody for.
    <nav
      aria-label="Sidebar"
      aria-busy={boot.phase === 'cold' ? true : undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* **The sidebar's whole horizontal inset, paid here and at the row.**
          Eight pixels of panel padding plus eight on every row is the 16px total
          left inset the density calls for (design-decisions §11). Nothing
          between the panel edge and the row's own padding adds anything — a
          zone that quietly added four of its own put every row at 20px, and the
          browser bar is what caught it. */}
      <SidebarContent className="sidebar-scroll-edges px-2 py-3">
        <SidebarChrome activeTarget={state.activeTarget}>
          <SidebarDnd displayNames={state.displayNames} rooms={state.rooms}>
            <SidebarZones model={model} />
          </SidebarDnd>
        </SidebarChrome>
      </SidebarContent>

      {/* **Outside the scroller, on purpose.** The promo card used to be the
          last child INSIDE `SidebarContent`, so anyone with more than a screen
          of rows never saw it again — and the three cards it competes with
          stacked in the footer instead. One slot, pinned here between the
          scroller and the footer, one card at a time (spec D4). */}
      <SidebarBottomSlot />
    </nav>
  );
}
