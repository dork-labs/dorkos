/**
 * The sidebar body: a landmark, a drag layer, and the sections.
 *
 * It was 875 lines of rules in JSX. Everything it used to decide — which rows
 * appear, in what order, under what cap, with what badge — is now
 * `buildSidebarModel`, and this composes the three things a renderer needs: the
 * `<nav>` landmark, the drag layer, and `SidebarSections`.
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
import { useLegacyPinMigration } from '../model/use-legacy-pin-migration';
import { useSidebarModel } from '../model/use-sidebar-model';
import { useSidebarState } from '../model/use-sidebar-state';
import { SidebarChrome } from './SidebarChrome';
import { SidebarDnd } from './dnd/SidebarDnd';
import { SidebarLandmark, useInsideSidebarLandmark } from './SidebarLandmark';
import { SidebarSections } from './SidebarSections';

const BODY_CLASS = 'flex min-h-0 flex-1 flex-col';

/**
 * The dashboard sidebar — the places conversations live, drawn from one model.
 *
 * The doors to Threads and the Directory, then the operator's own sections,
 * Channels and Direct messages: places, never sessions or threads. Nothing
 * reorders what the operator put somewhere (BC-28 → BC-33).
 */
export function DashboardSidebar() {
  useLegacyPinMigration();
  const state = useSidebarState();
  const model = useSidebarModel(state);
  const insideLandmark = useInsideSidebarLandmark();

  const body = (
    <>
      {/* **The sidebar's whole horizontal inset, paid here and at the row.**
          Eight pixels of panel padding plus eight on every row is the 16px total
          left inset the density calls for (design-decisions §11). Nothing
          between the panel edge and the row's own padding adds anything — a
          wrapper that quietly added four of its own put every row at 20px, and
          the browser bar is what caught it. */}
      <SidebarContent className="sidebar-scroll-edges px-2 py-3">
        <SidebarChrome activeTarget={state.activeTarget}>
          <SidebarDnd displayNames={state.displayNames} rooms={state.rooms}>
            <SidebarSections model={model} />
          </SidebarDnd>
        </SidebarChrome>
      </SidebarContent>

      {/* **Outside the scroller, on purpose.** The promo card used to be the
          last child INSIDE `SidebarContent`, so anyone with more than a screen
          of rows never saw it again — and the three cards it competes with
          stacked in the footer instead. One slot, pinned here between the
          scroller and the footer, one card at a time (spec D4). */}
      <SidebarBottomSlot />
    </>
  );

  // Sections sit inside the panel's one landmark, each labelled by its own heading.
  return insideLandmark ? (
    <div className={BODY_CLASS}>{body}</div>
  ) : (
    <SidebarLandmark className={BODY_CLASS}>{body}</SidebarLandmark>
  );
}
