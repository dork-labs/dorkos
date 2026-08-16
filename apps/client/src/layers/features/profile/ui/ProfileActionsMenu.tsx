/**
 * The profile's kebab — the rare stuff, and only the rare stuff (spec
 * `profile-unification` §1.2).
 *
 * What it offers is decided by relationship, not by kind: an agent you manage
 * gets the four management actions, a system agent gets the one that is legal
 * on it plus a line saying why the rest are missing, and everybody else gets
 * whatever their handle allows.
 *
 * @module features/profile/ui/ProfileActionsMenu
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreVertical } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { useCopyFeedback } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
import type { ProfileRelationship } from '../lib/profile-relationship';
import { useProfileAgent } from '../model/use-profile-agent';
import {
  ProfileAgentActions,
  useIsAgentBlocked,
  type ProfileAgentStep,
} from './ProfileAgentActions';

export interface ProfileActionsMenuProps {
  /** The identity the menu acts on. */
  member: TeamMember;
  /** What that identity is to you — which items exist at all. */
  relationship: ProfileRelationship;
}

/**
 * Whether this identity has a kebab at all.
 *
 * With one item and nothing to put in it, the kebab is a button that opens a
 * menu saying nothing — so an identity with no handle and no other action
 * simply has no kebab (§1.2).
 */
function hasProfileActions(member: TeamMember, relationship: ProfileRelationship): boolean {
  if (relationship === 'managed' || relationship === 'system') return true;
  return member.handle !== null;
}

/**
 * The kebab menu for one identity.
 *
 * Renders nothing when there is nothing to offer, so the caller can place it
 * unconditionally.
 */
export function ProfileActionsMenu({ member, relationship }: ProfileActionsMenuProps) {
  const [, copy] = useCopyFeedback();
  const [step, setStep] = useState<ProfileAgentStep>(null);
  const transport = useTransport();
  const queryClient = useQueryClient();

  const projectPath = member.agent?.projectPath ?? null;
  const isAgent = relationship === 'managed' || relationship === 'system';
  // Only the relationship that HAS a Block item asks whether it is blocked —
  // the read is a request, and a profile with no such item must not make it.
  const isBlocked = useIsAgentBlocked(relationship === 'managed' ? projectPath : null);
  // The slug, which is what `config.agents.defaultAgent` stores — the roster
  // carries a display name, and the two are not the same string. A cache hit:
  // the profile root has already read this manifest for the About row.
  const { agent } = useProfileAgent(member);

  const setDefault = useMutation({
    mutationFn: (slug: string) => transport.setDefaultAgent(slug),
    onSuccess: async () => {
      // Both keys, for the same reason every profile edit invalidates both
      // (§4): the roster's `isDefault` is what this menu reads back, and the
      // header's `default` badge is drawn from it.
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      await queryClient.invalidateQueries({ queryKey: TEAM_ROSTER_KEY });
      toast.success(`${member.displayName} is now the default agent`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!hasProfileActions(member, relationship)) return null;

  const slug = agent?.name ?? null;
  // The roster already answers this — `isDefault` is `config.agents.defaultAgent`
  // resolved server-side, including the fresh-install case where it is unset and
  // DorkBot is the effective default.
  const isDefault = member.agent?.isDefault === true;

  return (
    <>
      <ResponsiveDropdownMenu>
        <ResponsiveDropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={`Actions for ${member.displayName}`}>
            <MoreVertical className="size-(--size-icon-xs)" />
          </Button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent align="end">
          {/* Any agent can be the one new sessions start with, DorkBot included
              — so this item sits above the system-agent gate, not inside it. */}
          {/* Absent once it already is the default, rather than present and
              inert: the header's `default` badge has already said so, and an
              item that answers a tap with nothing is the dead affordance this
              design removes. */}
          {isAgent && slug !== null && !isDefault && (
            <ResponsiveDropdownMenuItem onSelect={() => setDefault.mutate(slug)}>
              Set as default
            </ResponsiveDropdownMenuItem>
          )}

          {member.handle !== null && (
            <ResponsiveDropdownMenuItem
              onSelect={() => {
                copy(`@${member.handle}`);
                toast.success('Copied');
              }}
            >
              Copy @handle
            </ResponsiveDropdownMenuItem>
          )}

          {relationship === 'managed' && projectPath !== null && (
            <>
              <ResponsiveDropdownMenuSeparator />
              <ResponsiveDropdownMenuItem onSelect={() => setStep('block')}>
                {isBlocked ? 'Unblock' : 'Block'}
              </ResponsiveDropdownMenuItem>
              <ResponsiveDropdownMenuItem onSelect={() => setStep('unregister')}>
                Unregister
              </ResponsiveDropdownMenuItem>
              <ResponsiveDropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setStep('delete')}
              >
                Delete agent and data
              </ResponsiveDropdownMenuItem>
            </>
          )}

          {/* Said rather than shown as three disabled items: a system agent is
              not one you have failed to get permission for, it is part of
              DorkOS, and a greyed-out Delete invites a second attempt. */}
          {relationship === 'system' && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              System agents can’t be blocked, unregistered or deleted.
            </p>
          )}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>

      {relationship === 'managed' && projectPath !== null && (
        <ProfileAgentActions
          member={member}
          projectPath={projectPath}
          step={step}
          onStepChange={setStep}
        />
      )}
    </>
  );
}
