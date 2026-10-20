import { Plus } from 'lucide-react';
import type { CommunitySpaceReadResult } from '@dorkos/shared/community-space-settings';
import { Button } from '@/layers/shared/ui';
import {
  availabilityLabel,
  groupPeople,
  headcount,
  initialOf,
  initialsOf,
  personDetail,
  roleLabel,
  tileColor,
  type SpaceRole,
} from '../lib/space-view';
import { LetterTile, LockedReason, ManageOnWeb, SettingsSection } from './SettingsBlocks';

/** Props for {@link SpaceMembersSection}. */
export interface SpaceMembersSectionProps {
  /** The directory read, or `undefined` while it loads. */
  members: CommunitySpaceReadResult<'members'> | undefined;
  /** The space's refusal, as its sentence, when it would not show who is in it. */
  refusal: string | null;
  /** The person's role. */
  role: SpaceRole;
  /** The person's own member id, to mark their row. */
  meId: string | null;
  /** Whether the space is unreachable now, so the section adds no reason of its own. */
  offline: boolean;
  /** The space's web settings at its Members section, where an owner or admin manages them. */
  manageUrl: string;
}

/**
 * Who is in the space: each person with their role as text and their agents under them, and the
 * Invite button, shown but off, with the reason beside it (DOR-3005). Invite links and mutes are
 * owner and admin business the app cannot read yet, so for them one row links to where they are.
 */
export function SpaceMembersSection({
  members,
  refusal,
  role,
  meId,
  offline,
  manageUrl,
}: SpaceMembersSectionProps) {
  const people = members ? groupPeople(members.value) : [];
  const moderator = role === 'owner' || role === 'admin';
  const reason = offline ? null : moderator ? (
    <ManageOnWeb href={manageUrl} />
  ) : (
    'Ask an owner or admin to invite or remove people.'
  );
  return (
    <SettingsSection
      title="Members"
      testId="space-settings-members"
      meta={
        members
          ? headcount(people, members.value.agents !== undefined, members.value.nextCursor !== null)
          : undefined
      }
      action={
        <Button variant="secondary" size="xs" disabled>
          <Plus aria-hidden />
          Invite
        </Button>
      }
      reason={reason}
    >
      {refusal ? (
        <div className="px-4 py-3">
          <LockedReason>{refusal}</LockedReason>
        </div>
      ) : members === undefined ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">Loading…</p>
      ) : (
        <ul className="flex flex-col" aria-label="People in this space">
          {people.map(({ person, agents }) => (
            <li key={person.memberId} className="flex flex-col">
              <div className="flex items-center gap-3 px-4 py-2.5">
                <span
                  aria-hidden
                  className="bg-background text-muted-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                >
                  {initialsOf(person.displayName)}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    <bdi>{person.displayName}</bdi>
                    {person.memberId === meId && (
                      <span className="text-muted-foreground ml-1.5 text-xs font-normal">You</span>
                    )}
                  </span>
                  <span className="text-muted-foreground truncate text-xs" dir="auto">
                    {personDetail({ person, agents })}
                  </span>
                </div>
                <span className="text-muted-foreground w-[104px] shrink-0 text-sm">
                  {roleLabel(person.role)}
                </span>
              </div>
              {agents.length > 0 && (
                <ul className="flex flex-col" aria-label={`${person.displayName}’s agents`}>
                  {agents.map((agent) => {
                    const availability = availabilityLabel(agent);
                    return (
                      <li key={agent.memberId} className="flex items-center gap-3 py-2 pr-4 pl-14">
                        <LetterTile
                          letter={initialOf(agent.displayName)}
                          color={tileColor(agent.memberId)}
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                            <span className="truncate" dir="auto">
                              {agent.displayName}
                            </span>
                            <span className="bg-background text-muted-foreground shrink-0 rounded px-1.5 text-[11px] font-normal">
                              Agent
                            </span>
                          </span>
                          {availability && (
                            <span className="text-muted-foreground text-xs">{availability}</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {moderator && !refusal && (
        <div className="px-4 py-3">
          <div className="text-sm font-medium">Invite links and mutes</div>
          {!offline && <ManageOnWeb href={manageUrl} />}
        </div>
      )}
    </SettingsSection>
  );
}
