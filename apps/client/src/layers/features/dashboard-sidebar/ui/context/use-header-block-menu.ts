/**
 * The header block menu's live inputs: the installation's name, the identity
 * rows above the context list (you, your DorkOS account, Settings) and the
 * version line below it.
 *
 * One hook, called by the context switcher itself, so the desktop header and
 * the phone's top bar show the same rows. Before it existed the phone trigger
 * was handed an empty list, and phones lost Settings, the account rows and the
 * version line, which is that number's one home in the chrome (BC-44).
 *
 * @module features/dashboard-sidebar/ui/context/use-header-block-menu
 */
import { createElement, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { OPERATOR_FALLBACK_DISPLAY_NAME, type TeamMember } from '@dorkos/shared/team-schemas';
import { isNewer } from '@/layers/shared/lib';
import { useProfileDeepLink, useSettingsDeepLink, useTransport } from '@/layers/shared/model';
import { IdentityAvatar, type SidebarMenuNode } from '@/layers/shared/ui';
import { teamMemberFace, useTeamRoster } from '@/layers/entities/team';
import { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/entities/config';
import { describeDorkosAccountLine, useDorkosAccountLine } from '@/layers/features/cloud-plan';
import {
  buildHeaderBlockIdentityNodes,
  buildHeaderBlockVersionNodes,
  type HeaderBlockIdentityModel,
} from '../header-block-menu';

/**
 * What this installation is called.
 *
 * @param displayName - The operator's own profile display name, if known.
 */
export function teamNameFor(displayName: string | null): string {
  const trimmed = displayName?.trim() ?? '';
  if (trimmed.length === 0 || trimmed === OPERATOR_FALLBACK_DISPLAY_NAME) return 'Your team';
  return trimmed.endsWith('s') ? `${trimmed}’ team` : `${trimmed}’s team`;
}

/**
 * Your own face, at the size its row draws it.
 *
 * @param member - Your roster row.
 * @param size - The avatar size.
 */
function avatarFor(member: TeamMember, size: 'xs' | 'sm') {
  const face = teamMemberFace(member);
  return createElement(IdentityAvatar, {
    size,
    kind: face.kind,
    color: face.color,
    emoji: face.emoji,
    imageUrl: face.imageUrl,
    fallback: face.fallback,
    origin: face.origin,
  });
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
   * The rows above the context list: you, your DorkOS account, Settings.
   * Unguarded; the switcher arms the close-focus guard over every row.
   */
  identityNodes: SidebarMenuNode[];
  /**
   * The rows below the context list: the selected context's lifecycle rows,
   * then the version line. Unguarded, like {@link identityNodes}.
   */
  nodes: SidebarMenuNode[];
}

/**
 * Who you are, whether this computer is signed in to a DorkOS account, and the
 * doors behind both — the model the header menu's identity rows and the phone's
 * You tab are both drawn from, so the two cannot say different things.
 *
 * @param size - The face's size: the menu row's icon size, or the You tab's.
 */
export function useIdentityModel(size: 'xs' | 'sm' = 'xs'): HeaderBlockIdentityModel {
  const roster = useTeamRoster();
  const { open: openSettings } = useSettingsDeepLink();
  const { open: openProfile } = useProfileDeepLink();
  const accountLine = useDorkosAccountLine();
  const self = roster.data?.members.find((member) => member.isSelf) ?? null;

  return {
    you:
      self === null
        ? null
        : {
            name: self.displayName,
            face: avatarFor(self, size),
            onOpen: () => openProfile(self.id),
          },
    accountStatus: describeDorkosAccountLine(accountLine),
    onOpenAccount: () => openSettings('account'),
    onOpenSettings: () => openSettings(),
  };
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
  const identity = useIdentityModel();

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
    identityNodes: buildHeaderBlockIdentityNodes(identity),
    nodes: [
      ...contextNodes,
      ...buildHeaderBlockVersionNodes({
        version: serverConfig?.version ?? null,
        isDevMode: serverConfig?.isDevMode ?? false,
        onCheckForUpdates: () => void handleCheckForUpdates(),
      }),
    ],
  };
}
