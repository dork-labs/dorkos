import { motion } from 'motion/react';
import { Badge } from '@/layers/shared/ui';
import { hashToHslColor, hashToEmoji, shortenHomePath } from '@/layers/shared/lib';
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
  const color = agent.color ?? hashToHslColor(agent.id);
  const emoji = agent.icon ?? hashToEmoji(agent.id);

  return (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: 240 }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className="border-l overflow-hidden flex-shrink-0 will-change-[width]"
    >
      <div className="w-[240px] p-4 space-y-3">
        {/* Agent identity */}
        <div className="flex items-center gap-2">
          <span
            className="size-2.5 flex-shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-base">{emoji}</span>
          <span className="text-sm font-semibold truncate">{agent.name}</span>
        </div>

        {/* CWD path */}
        <p className="text-muted-foreground text-xs truncate">
          {shortenHomePath(agent.projectPath)}
        </p>

        {/* Health + session count inline */}
        <div className="flex items-center gap-3 text-xs">
          {health && (
            <Badge
              variant={health.status === 'active' ? 'default' : 'secondary'}
              className="text-[10px] px-1.5 py-0"
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
            <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
              Recent
            </p>
            <ul className="space-y-0.5">
              {recentSessions.map((session) => (
                <li key={session.id} className="text-muted-foreground truncate text-xs">
                  {session.title ?? 'Untitled'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.div>
  );
}
