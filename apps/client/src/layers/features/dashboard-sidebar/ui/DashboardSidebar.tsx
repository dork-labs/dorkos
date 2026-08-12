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
import { PromoSlot } from '@/layers/features/feature-promos';
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

  return (
    // The panel root is the sidebar's one landmark (R2). Zones are sections
    // inside it, each labelled by its own heading.
    <nav aria-label="Sidebar" className="flex min-h-0 flex-1 flex-col">
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

        <PromoSlot placement="dashboard-sidebar" maxUnits={3} />
      </SidebarContent>
    </nav>
  );
}
