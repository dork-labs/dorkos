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
 * Animates in/out with a spring-based width transition.
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
      animate={{ opacity: 1, width: '60%' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className="border-l overflow-hidden flex-shrink-0"
    >
      <div className="p-4 space-y-4">
        {/* Agent identity header */}
        <div className="flex items-center gap-3">
          <span
            className="size-3 flex-shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-lg">{emoji}</span>
          <span className="font-semibold truncate">{agent.name}</span>
        </div>

        {/* CWD path */}
        <p className="text-muted-foreground text-sm truncate">
          {shortenHomePath(agent.projectPath)}
        </p>

        {/* Session count + recent sessions */}
        <div className="space-y-2">
          <p className="text-sm">
            <span className="text-muted-foreground">Sessions:</span>{' '}
            <span className="font-medium">{sessionCount}</span>
          </p>
          {recentSessions.length > 0 && (
            <ul className="space-y-1">
              {recentSessions.map((session) => (
                <li key={session.id} className="text-muted-foreground truncate text-xs">
                  {session.title ?? 'Untitled'}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Health status */}
        {health && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Health:</span>
            <Badge variant={health.status === 'active' ? 'default' : 'destructive'}>
              {health.status}
            </Badge>
          </div>
        )}
      </div>
    </motion.div>
  );
}
