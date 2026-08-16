/**
 * Personality — how an agent talks, in the eight archetypes and six sliders
 * behind them (spec `profile-unification` §1.4).
 *
 * @module features/profile/ui/popovers/PersonalityPopover
 */
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { Skeleton } from '@/layers/shared/ui';
import { PersonalityPicker } from '@/layers/entities/agent';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePickContentProps } from './types';

/**
 * Change how an agent talks.
 *
 * `compact`, because this is a popover on a desktop and a bottom drawer on a
 * phone — the roomy layout belongs to onboarding, where picking a personality is
 * the whole screen rather than one row of a profile.
 *
 * Traits are written to the manifest only. The trait block inside SOUL.md is
 * rendered from them server-side when the agent next runs, so the picker does
 * not have to compose a file to change a voice.
 */
export function PersonalityPopover({ member }: ProfilePickContentProps) {
  const { agent, isPending, update } = useProfileAgent(member);

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (!agent) {
    return (
      <p className="text-muted-foreground p-1 text-sm">Couldn’t read this agent’s personality.</p>
    );
  }

  return (
    <PersonalityPicker
      traits={(agent.traits ?? DEFAULT_TRAITS) as Traits}
      onTraitsChange={(traits) => update({ traits })}
      compact
      className="p-1"
    />
  );
}
