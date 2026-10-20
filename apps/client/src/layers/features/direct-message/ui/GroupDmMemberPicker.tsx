/**
 * The member picker at the top of a group DM's right panel (DOR-3075).
 *
 * @module features/direct-message/ui/GroupDmMemberPicker
 */
import { useEffect } from 'react';
import { cn, hashToHslColor, initialOf } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { IdentityAvatar } from '@/layers/shared/ui';
import type { GroupDmMember } from '../lib/group-dm';

/** What the picker offers. */
export interface GroupDmMemberPickerProps {
  /** The group DM's agents, in roster order. */
  members: readonly GroupDmMember[];
}

/**
 * Pick which member of a group DM the panel's tabs are about.
 *
 * It writes the same explicit pick a room's Profile tab already reads, so
 * Profile, Computer and Work follow it, and it is let go the same way: by
 * leaving the room. With no pick standing (or a pick of someone not in this
 * DM), the first agent is picked, so the tabs have someone to be about. That
 * waits for a plain effect on purpose: the shell drops a pick when a room is
 * entered, in a layout effect, and this has to land after it.
 *
 * @param props - See {@link GroupDmMemberPickerProps}.
 */
export function GroupDmMemberPicker({ members }: GroupDmMemberPickerProps) {
  const picked = useAppStore((s) => s.explicitAgentPath);
  const setPicked = useAppStore((s) => s.setExplicitAgentPath);
  const pickedIsMember = members.some((member) => member.agentPath === picked);
  const first = members[0]?.agentPath ?? null;

  useEffect(() => {
    if (!pickedIsMember && first !== null) setPicked(first);
  }, [pickedIsMember, first, setPicked]);

  if (members.length === 0) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Show the panel for"
      data-testid="group-dm-member-picker"
      className="flex shrink-0 flex-wrap gap-1.5 border-b px-3 py-2"
    >
      {members.map((member) => {
        const selected = member.agentPath === picked;
        return (
          <button
            key={member.authorId}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPicked(member.agentPath)}
            className={cn(
              'focus-ring flex h-7 max-w-40 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors',
              selected
                ? 'bg-accent text-foreground border-transparent'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <IdentityAvatar
              aria-hidden
              size="xs"
              className="size-4 shrink-0 text-[9px]"
              kind="agent"
              color={member.color ?? hashToHslColor(member.authorId)}
              emoji={member.emoji}
              badge={null}
              fallback={initialOf(member.displayName)}
            />
            <span className="truncate">{member.displayName}</span>
          </button>
        );
      })}
    </div>
  );
}
