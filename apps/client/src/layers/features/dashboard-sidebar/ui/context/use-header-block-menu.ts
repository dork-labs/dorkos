/**
 * The header block menu's live inputs: the installation's name and the
 * account/settings/version rows that sit under the context list.
 *
 * One hook, called by the context switcher itself, so the desktop header and
 * the phone's top bar show the same rows. Before it existed the phone trigger
 * was handed an empty list, and phones lost Workspace settings, Account and the
 * version line, which is that number's one home in the chrome (BC-44).
 *
 * @module features/dashboard-sidebar/ui/context/use-header-block-menu
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { isNewer } from '@/layers/shared/lib';
import { useProfileDeepLink, useSettingsDeepLink, useTransport } from '@/layers/shared/model';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import { useTeamRoster } from '@/layers/entities/team';
import { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/entities/config';
import { buildHeaderBlockMenuNodes } from '../header-block-menu';

/**
 * What this installation is called.
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
  return trimmed.endsWith('s') ? `${trimmed}’ team` : `${trimmed}’s team`;
}

/** What the header block menu shows. */
export interface HeaderBlockMenu {
  /** The installation's name, from the operator's own profile. */
  teamName: string;
  /**
   * Whether the name is still on its way.
   *
   * **A returning operator is never told their team is "Your team"** (spec
   * D6). The fallback is the honest answer for an install that has no name to
   * give; it is the WRONG answer for the second before the roster lands. Keyed
   * on the roster alone, not on the boot phase: pairing the two put the
   * placeholder back on the slow installs the boot ceiling exists for.
   */
  nameUnknown: boolean;
  /**
   * The unguarded rows: the context's lifecycle rows, then settings, account
   * and version. The switcher arms the close-focus guard over all of them.
   */
  nodes: SidebarMenuNode[];
}

/**
 * Build the header block menu from the roster and the server config.
 *
 * @param contextNodes - The selected context's lifecycle rows, drawn first and
 *   guarded with everything else. Built by the switcher, which knows the
 *   selection; see `community-context-actions.ts`.
 */
export function useHeaderBlockMenu(contextNodes: SidebarMenuNode[] = []): HeaderBlockMenu {
  const roster = useTeamRoster();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { open: openSettings } = useSettingsDeepLink();
  const { open: openProfile } = useProfileDeepLink();

  const self = roster.data?.members.find((member) => member.isSelf) ?? null;

  // The same cache entry the rest of the app reads, so asking here costs
  // nothing extra.
  const { data: serverConfig, refetch } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const handleCheckForUpdates = useCallback(async () => {
    // The server recomputes `latestVersion` when it answers, so a refetch IS
    // the check — there is no second endpoint to call and no spinner to invent.
    await queryClient.invalidateQueries({ queryKey: configKeys.all });
    const fresh = await refetch();
    const current = fresh.data?.version;
    const latest = fresh.data?.latestVersion ?? null;
    if (current === undefined) {
      toast.error('Couldn’t check for updates');
      return;
    }
    if (latest !== null && isNewer(latest, current)) {
      toast.success(`Version ${latest} is available`);
      return;
    }
    toast.success('You’re up to date');
  }, [queryClient, refetch]);

  return {
    teamName: teamNameFor(self?.displayName ?? null),
    nameUnknown: roster.isPending,
    nodes: [
      ...contextNodes,
      ...(contextNodes.length > 0 ? [{ kind: 'separator' as const, id: 'sep-context' }] : []),
      ...buildHeaderBlockMenuNodes({
        onOpenSettings: () => openSettings(),
        onOpenAccount: self === null ? null : () => openProfile(self.id),
        version: serverConfig?.version ?? null,
        isDevMode: serverConfig?.isDevMode ?? false,
        onCheckForUpdates: () => void handleCheckForUpdates(),
      }),
    ],
  };
}
