/**
 * The sidebar's header block: whose installation this is, one New button, one ⌘K
 * pill (BC-43 → BC-46).
 *
 * **Persistent chrome.** `AppShell` mounts this OUTSIDE the `sidebar.body` swap
 * region, so a marketplace takeover replaces the body and leaves this standing
 * — the panel's identity and the way to make things do not belong to whichever
 * route is on screen (spec R2, P2 AC-8).
 *
 * **The switcher.** The block is a button named after the operator ("Dorian's
 * team"), opening a menu with you, your DorkOS account and Settings at the top
 * and a quiet version line at the bottom (DOR-2628). Connected communities are additional rows in this same menu
 * (`CommunityContextSwitcher`): single-player → multi-player is "the menu gets
 * longer", with zero relayout of anything outside it. It is not a workspace
 * manager and it adds no workspace surface (§16 Non-Goals).
 *
 * @module features/dashboard-sidebar/ui/SidebarHeaderBlock
 */
import { useIsMobile } from '@/layers/shared/model';
import { SidebarHeader } from '@/layers/shared/ui';
import { NewMenu } from './NewMenu';
import { SidebarSearchPill } from './SidebarSearchPill';
import { CommunityContextSwitcher } from './context/CommunityContextSwitcher';

export { teamNameFor } from './context/use-header-block-menu';

/**
 * The switcher's trigger: the operator's name on a quiet row.
 *
 * Its ring is the shared `focus-ring`, 2px out, rather than a `ring-2` of its
 * own, and its tint changes on `--dur-fast` (Phase 4 S5).
 */
const SWITCHER_TRIGGER =
  'text-sidebar-foreground hover:bg-sidebar-accent/70 data-[state=open]:bg-sidebar-accent/70 focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-control font-semibold transition-colors duration-(--dur-fast)';

/**
 * The header block.
 *
 * On a phone the context switcher lives in the persistent top bar instead
 * (`MobileCommunityContextSwitcher`), with the same menu, so this block
 * renders only Find and New there, side by side on one row: New alone on a
 * row of its own spent a full 44px line on a 74px button (Phase 4 S6).
 */
export function SidebarHeaderBlock() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      // No hairline under the header, on a phone either (R1). `pb-1`: the
      // list starts 20px under Find, not 32 (Phase 4 P1).
      <SidebarHeader className="flex-row items-center gap-2 px-2 pt-3 pb-1">
        <SidebarSearchPill className="min-w-0 flex-1" />
        <NewMenu />
      </SidebarHeader>
    );
  }

  return (
    // No hairline under the header. Separation in this panel is tint and a
    // scroll-edge shadow, never a border: a 1px line reads as a seam between
    // two surfaces, and the header and the roster are one surface (R1).
    <SidebarHeader className="gap-2 px-2 pt-3 pb-1">
      <div className="flex items-center gap-1">
        <CommunityContextSwitcher triggerClassName={SWITCHER_TRIGGER} />
        <NewMenu />
      </div>
      <SidebarSearchPill />
    </SidebarHeader>
  );
}
