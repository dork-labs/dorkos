/**
 * The sidebar's header block: whose cockpit this is, one New button, one ⌘K
 * pill (BC-43 → BC-46).
 *
 * **Persistent chrome.** `AppShell` mounts this OUTSIDE the `sidebar.body` swap
 * region, so a marketplace takeover replaces the body and leaves this standing
 * — the panel's identity and the way to make things do not belong to whichever
 * route is on screen (spec R2, P2 AC-8).
 *
 * **A switcher in waiting.** The block is a button from day one, named after
 * the operator ("Dorian's team"), opening a menu with Workspace settings,
 * Account and a quiet version line. When communities ship they become
 * additional rows in this same menu: single-player → multi-player is "the menu
 * gets longer", with zero relayout of anything outside it. It is not a
 * workspace manager and it adds no workspace surface (§16 Non-Goals).
 *
 * @module features/dashboard-sidebar/ui/SidebarHeaderBlock
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { useProfileDeepLink, useSettingsDeepLink, useTransport } from '@/layers/shared/model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  SidebarHeader,
  SidebarMenuNodes,
  useGuardedMenuNodes,
} from '@/layers/shared/ui';
import { useTeamRoster } from '@/layers/entities/team';
import { isNewer } from '@/layers/features/status';
import { buildHeaderBlockMenuNodes } from './header-block-menu';
import { NewMenu } from './NewMenu';
import { SidebarSearchPill } from './SidebarSearchPill';

/**
 * What this cockpit is called.
 *
 * Named after the operator, because on a single-player install the team IS the
 * operator plus their agents. "Your team" is the honest fallback in three
 * cases, and the third is the one a browser found: the roster has not landed
 * yet, the roster is empty (the Obsidian embed, by construction), or the person
 * has not told DorkOS their name — in which case the roster answers with the
 * literal `'You'`, and possessing that reads "You's team". Settings › Profile
 * already recognises the same literal for the same reason (DOR-979).
 *
 * @param displayName - The operator's own profile display name, if known.
 */
export function teamNameFor(displayName: string | null): string {
  const trimmed = displayName?.trim() ?? '';
  if (trimmed.length === 0 || trimmed === OPERATOR_FALLBACK_DISPLAY_NAME) return 'Your team';
  return trimmed.endsWith('s') ? `${trimmed}' team` : `${trimmed}'s team`;
}

/** The header block. */
export function SidebarHeaderBlock() {
  const roster = useTeamRoster();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { open: openSettings } = useSettingsDeepLink();
  const { open: openProfile } = useProfileDeepLink();

  const self = roster.data?.members.find((member) => member.isSelf) ?? null;
  const teamName = teamNameFor(self?.displayName ?? null);

  // The same cache entry the rest of the cockpit reads, so asking here costs
  // nothing extra.
  const { data: serverConfig, refetch } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const handleCheckForUpdates = useCallback(async () => {
    // The server recomputes `latestVersion` when it answers, so a refetch IS
    // the check — there is no second endpoint to call and no spinner to invent.
    await queryClient.invalidateQueries({ queryKey: ['config'] });
    const fresh = await refetch();
    const current = fresh.data?.version;
    const latest = fresh.data?.latestVersion ?? null;
    if (current === undefined) {
      toast.error('Could not check for updates');
      return;
    }
    if (latest !== null && isNewer(latest, current)) {
      toast.success(`Version ${latest} is available`);
      return;
    }
    toast.success("You're up to date");
  }, [queryClient, refetch]);

  const nodes = buildHeaderBlockMenuNodes({
    onOpenSettings: () => openSettings(),
    onOpenAccount: self === null ? null : () => openProfile(self.id),
    version: serverConfig?.version ?? null,
    isDevMode: serverConfig?.isDevMode ?? false,
    onCheckForUpdates: () => void handleCheckForUpdates(),
  });

  // Workspace settings and Account both open a dialog, so both need the
  // close-focus guard for the reason DOR-329 records.
  const guarded = useGuardedMenuNodes(nodes);

  return (
    // No hairline under the header. Separation in this panel is tint and a
    // scroll-edge shadow, never a border: a 1px line reads as a seam between
    // two surfaces, and the header and the roster are one surface (R1).
    <SidebarHeader className="gap-2 px-2 py-3">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="sidebar-header-block"
              // Not "workspace menu": the sidebar says "project" for the
              // repo/cwd dimension and says "workspace" in exactly one place,
              // the menu row that names the existing settings surface (§16,
              // R4). A screen reader hears the same vocabulary a sighted
              // reader does.
              aria-label={`${teamName} — menu`}
              className="text-sidebar-foreground hover:bg-sidebar-accent/70 focus-visible:ring-sidebar-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold outline-hidden transition-colors duration-150 focus-visible:ring-2"
            >
              <span className="truncate">{teamName}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          {/* Portalled by the primitive, which is what makes BC-43's promise
              structural: however long this list grows, it renders outside the
              header block's own box and cannot move anything in it. */}
          <DropdownMenuContent
            align="start"
            className="w-56"
            onCloseAutoFocus={guarded.onCloseAutoFocus}
          >
            <SidebarMenuNodes variant="dropdown" nodes={guarded.nodes} />
          </DropdownMenuContent>
        </DropdownMenu>
        <NewMenu />
      </div>
      <SidebarSearchPill />
    </SidebarHeader>
  );
}
