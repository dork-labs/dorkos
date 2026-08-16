/**
 * About — what this agent is for, in its own words (spec
 * `profile-unification` §1.5).
 *
 * **Read-only in this slice.** The editable description and the capability
 * chips are W2.2's, ported from the Agent Hub's Config tab; until then this
 * shows what the manifest says rather than an editor that saves nowhere.
 *
 * @module features/profile/ui/pages/AboutPage
 */
import { useCurrentAgent } from '@/layers/entities/agent';
import { Skeleton } from '@/layers/shared/ui';
import type { ProfilePageContentProps } from './types';

/** The agent's description, or an honest sentence about there not being one. */
export function AboutPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;
  const manifest = useCurrentAgent(projectPath);

  if (projectPath !== null && manifest.isPending) return <Skeleton className="h-16 w-full" />;

  const description = manifest.data?.description?.trim();
  if (!description) {
    return (
      <p className="text-muted-foreground text-sm">
        {member.displayName} hasn’t said what it’s for yet.
      </p>
    );
  }

  return <p className="text-sm leading-relaxed whitespace-pre-wrap">{description}</p>;
}
