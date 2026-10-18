/**
 * The Profile tab's icon: the avatar of the agent the panel is about (FB-60).
 *
 * The tab says whose profile it holds before you open it, so if the panel and
 * the chat ever disagree about the agent, the mismatch is visible next to the
 * chat header. Falls back to the generic person glyph when no agent is docked
 * or its manifest has not loaded.
 *
 * @module features/profile/ui/ProfileTabIcon
 */
import { forwardRef } from 'react';
import { User, type LucideProps } from 'lucide-react';
import { AgentAvatar, resolveAgentVisual, useCurrentAgent } from '@/layers/entities/agent';
import { cn } from '@/layers/shared/lib';
import { useDockedAgentPath } from '../model/use-docked-agent';

/**
 * Drop-in for a lucide icon in the right panel's tab strip. A `forwardRef`
 * because a panel contribution's `icon` is typed as one; the ref lands on the
 * fallback glyph only.
 */
export const ProfileTabIcon = forwardRef<SVGSVGElement, LucideProps>(function ProfileTabIcon(
  { className },
  ref
) {
  const agentPath = useDockedAgentPath();
  const { data: agent } = useCurrentAgent(agentPath);
  if (!agentPath || !agent) return <User ref={ref} className={className} />;
  const visual = resolveAgentVisual(agent);
  // 16px, a touch larger than the 14px glyphs beside it, as faces need.
  return (
    <span
      data-testid="profile-tab-avatar"
      className={cn('inline-flex shrink-0', className, 'size-4')}
    >
      <AgentAvatar
        color={visual.color}
        emoji={visual.emoji}
        size="xs"
        className="size-4 text-[10px]"
      />
    </span>
  );
});
