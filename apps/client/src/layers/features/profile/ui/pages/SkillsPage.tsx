/**
 * Skills — the skill-packs installed for this agent (spec
 * `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/SkillsPage
 */
import { Package } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';
import { SkillPacksList } from '@/layers/entities/marketplace';
import type { ProfilePageContentProps } from './types';

/**
 * What this agent knows how to do, and where to get it more.
 *
 * The marketplace link is the page's only action, so it sits at the foot rather
 * than in the header: it is what you do after reading the list, not before.
 */
export function SkillsPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;
  const navigate = useSafeNavigate();

  if (projectPath === null) {
    return <p className="text-muted-foreground text-sm">This agent’s folder isn’t known here.</p>;
  }

  return (
    <div className="flex flex-col gap-2" data-slot="profile-skills">
      <SkillPacksList projectPath={projectPath} />
      {navigate && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground w-full"
          onClick={() => void navigate({ to: '/marketplace', search: { type: 'skill-pack' } })}
        >
          <Package aria-hidden className="mr-1.5 size-3.5" />
          Browse skill-packs
        </Button>
      )}
    </div>
  );
}
