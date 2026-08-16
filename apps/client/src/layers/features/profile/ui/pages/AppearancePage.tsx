/**
 * Appearance — the face an agent wears and the voice it speaks in, on one page
 * (spec `profile-unification` §1.4, D4).
 *
 * A page rather than a popover because the pickers are large: eighteen colours,
 * a grid of emoji and eight personality archetypes do not belong in a panel
 * hanging off a row. Two sections, no tabs — an agent's colour and its manner
 * are the same decision made twice, and the operator arrives here having tapped
 * one thing: its face.
 *
 * @module features/profile/ui/pages/AppearancePage
 */
import { useState } from 'react';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { hashToEmoji, hashToHslColor } from '@/layers/shared/lib';
import { IdentityAvatar, Skeleton } from '@/layers/shared/ui';
import { AvatarPickerPanel, PersonalityPicker } from '@/layers/entities/agent';
import { teamMemberFace } from '@/layers/entities/team';
import { personalityUpdate } from '../../lib/soul-file';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** A section heading, in the quiet register the rest of the profile uses. */
function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
      {children}
    </h3>
  );
}

/**
 * Change how an agent looks and how it talks.
 *
 * The page draws its **own** big face above the swatches, and that is what the
 * hover preview paints. The Hub previewed into a hero the picker had replaced,
 * so a colour under the cursor changed something off screen; here the thing
 * being chosen is the thing you are looking at. It is a plain `IdentityAvatar`
 * rather than `ProfileFace` on purpose — the strip above already carries the
 * shared layout id, and two discs claiming one id fight over the flight.
 */
export function AppearancePage({ member }: ProfilePageContentProps) {
  const { agent, isPending, update } = useProfileAgent(member);
  const [preview, setPreview] = useState<string | null>(null);

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (!agent) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s appearance.</p>;
  }

  const face = teamMemberFace(member);
  const color = preview ?? agent.color ?? hashToHslColor(agent.id);
  const emoji = agent.icon ?? hashToEmoji(agent.id);

  return (
    <div className="flex flex-col gap-5" data-slot="profile-appearance">
      <div className="flex justify-center pt-1">
        <IdentityAvatar
          size="lg"
          kind={face.kind}
          color={color}
          emoji={emoji}
          fallback={face.fallback}
          origin={face.origin}
        />
      </div>

      <AvatarPickerPanel agent={agent} onUpdate={update} onPreviewColor={setPreview} />

      <div className="space-y-2 border-t pt-4">
        <SectionLabel>Personality</SectionLabel>
        <PersonalityPicker
          traits={(agent.traits ?? DEFAULT_TRAITS) as Traits}
          // Manifest AND SOUL.md, or the change never reaches a turn — see
          // `personalityUpdate`.
          onTraitsChange={(traits) => update(personalityUpdate(agent, traits))}
          compact
        />
      </div>
    </div>
  );
}
