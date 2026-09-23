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
 * team"), opening a menu with Workspace settings, Account and a quiet version
 * line. Connected communities are additional rows in this same menu
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
 * The header block.
 *
 * On a phone the context switcher lives in the persistent top bar instead
 * (`MobileCommunityContextSwitcher`), with the same menu, so this block
 * renders only New and search there rather than a second trigger.
 */
export function SidebarHeaderBlock() {
  const isMobile = useIsMobile();

  return (
    // No hairline under the header. Separation in this panel is tint and a
    // scroll-edge shadow, never a border: a 1px line reads as a seam between
    // two surfaces, and the header and the roster are one surface (R1).
    <SidebarHeader className="gap-2 px-2 py-3">
      <div className="flex items-center gap-1">
        {!isMobile && (
          <CommunityContextSwitcher triggerClassName="text-sidebar-foreground hover:bg-sidebar-accent/70 focus-visible:ring-sidebar-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold outline-hidden transition-colors duration-150 focus-visible:ring-2" />
        )}
        <NewMenu />
      </div>
      <SidebarSearchPill />
    </SidebarHeader>
  );
}
