import { motion } from 'motion/react';
import { Badge } from '@/layers/shared/ui';
import { getAgentDisplayName, shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
import { AgentAvatar } from '@/layers/entities/agent';
import { usePreviewData } from '../model/use-preview-data';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentPreviewPanelProps {
  /** The agent to preview */
  agent: AgentPathEntry;
}

/**
 * Right-side preview panel for the command palette.
 *
 * Shows agent identity (name, color, emoji), CWD path, session count
 * with recent session titles, and mesh health status.
 * Animates in/out with a width transition.
 *
 * Only rendered on desktop (hidden by parent when useIsMobile() returns true).
 */
export function AgentPreviewPanel({ agent }: AgentPreviewPanelProps) {
  const { sessionCount, recentSessions, health } = usePreviewData(agent.id, agent.projectPath);
  const { color, emoji } = resolveAgentVisual(agent);

  return (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: 240 }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className="flex-shrink-0 overflow-hidden border-l will-change-[width]"
    >
      <div className="w-[240px] space-y-3 p-4">
        {/* Agent identity */}
        <div className="flex items-center gap-2">
          {/* `sm`, where the palette's own rows use `xs`: this line is the
              panel's heading, not another row in the list, and the hand-rolled
              mark it replaces was already drawn a step larger than a row's. */}
          <AgentAvatar color={color} emoji={emoji} size="sm" className="shrink-0" />
          <span className="truncate text-sm font-semibold">{getAgentDisplayName(agent)}</span>
        </div>

        {/* CWD path */}
        <p className="text-muted-foreground truncate text-xs">
          {shortenHomePath(agent.projectPath)}
        </p>

        {/* Health + session count inline */}
        <div className="flex items-center gap-3 text-xs">
          {health && (
            <Badge
              variant={health.status === 'active' ? 'default' : 'secondary'}
              className="text-3xs px-1.5 py-0"
            >
              {health.status}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
        </div>

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <div className="space-y-1 pt-1">
            <p className="text-muted-foreground text-3xs font-medium tracking-wider uppercase">
              Recent
            </p>
            <ul className="space-y-0.5">
              {recentSessions.map((session) => (
                <li key={session.id} className="text-muted-foreground truncate text-xs">
                  {session.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.div>
  );
}
