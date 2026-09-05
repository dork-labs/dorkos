/**
 * Personality — how an agent talks, in the eight archetypes and six sliders
 * behind them (spec `profile-unification` §1.4).
 *
 * @module features/profile/ui/popovers/PersonalityPopover
 */
import { Skeleton } from '@/layers/shared/ui';
import { PersonalityPicker } from '@/layers/entities/agent';
import { useProfileAgent } from '../../model/use-profile-agent';
import { usePersonalityCommit } from '../../model/use-personality-commit';
import type { ProfilePickContentProps } from './types';

/**
 * Change how an agent talks.
 *
 * `compact`, because this is a popover on a desktop and a bottom drawer on a
 * phone — the roomy layout belongs to onboarding, where picking a personality is
 * the whole screen rather than one row of a profile.
 *
 * The traits go to the manifest **and** to SOUL.md, through the same update the
 * panel this replaced always sent (`personalityUpdate`, inside
 * `usePersonalityCommit`). Writing the manifest alone is
 * what a turn does not necessarily read: the trait block is regenerated in
 * place only where markers already exist, so an agent whose SOUL.md was
 * hand-written or absent kept its old voice while this panel showed the new one.
 *
 * The save waits for the sliders to settle, and is flushed if this popover is
 * dismissed first — see `usePersonalityCommit`.
 */
export function PersonalityPopover({ member }: ProfilePickContentProps) {
  const { agent, isPending, update } = useProfileAgent(member);
  const personality = usePersonalityCommit(agent, update);

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (!agent) {
    return (
      <p className="text-muted-foreground p-1 text-sm">Couldn’t read this agent’s personality.</p>
    );
  }

  return (
    <PersonalityPicker
      traits={personality.traits}
      onTraitsChange={personality.onTraitsChange}
      compact
      className="p-1"
    />
  );
}
