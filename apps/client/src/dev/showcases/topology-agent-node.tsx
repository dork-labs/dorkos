import { Zap, Clock } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { AgentAvatar } from '@/layers/entities/agent';

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export interface AgentDemoData {
  label: string;
  emoji: string;
  avatarColor: string;
  healthStatus: 'active' | 'inactive' | 'stale' | 'unreachable';
  runtime: string;
  capabilities: string[];
  borderColor?: string;
  description?: string;
  relayAdapters?: string[];
  taskCount?: number;
  behavior?: { responseMode: string };
  lastSeenAt?: string;
}

/* ---------------------------------------------------------------------------
 * Visual components — three level-of-detail bands
 * --------------------------------------------------------------------------- */

/** Compact pill rendered at zoom < 0.6 (~120px wide). */
export function AgentCompactPill({ d }: { d: AgentDemoData }) {
  return (
    <div
      className="bg-card flex w-[120px] items-center gap-1.5 rounded-full border px-2 py-0.5 shadow-sm"
      style={d.borderColor ? { borderLeft: `3px solid ${d.borderColor}` } : undefined}
    >
      <AgentAvatar color={d.avatarColor} emoji={d.emoji} healthStatus={d.healthStatus} size="xs" />
      <span className="text-foreground truncate text-xs font-medium">{d.label}</span>
    </div>
  );
}

/** Default card rendered at zoom 0.6–1.2 (~200px wide). */
export function AgentDefaultCard({ d }: { d: AgentDemoData }) {
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasTasks = d.taskCount != null && d.taskCount > 0;

  return (
    <div
      className="bg-card w-[200px] rounded-lg border px-3 py-2 shadow-sm"
      style={d.borderColor ? { borderLeft: `3px solid ${d.borderColor}` } : undefined}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar
          color={d.avatarColor}
          emoji={d.emoji}
          healthStatus={d.healthStatus}
          size="sm"
        />
        <span className="text-foreground truncate text-sm font-medium">{d.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {d.runtime}
        </Badge>
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
      </div>
      {(hasRelay || hasTasks) && (
        <div className="text-muted-foreground mt-1.5 flex items-center gap-2">
          {hasRelay && <Zap className="size-3" />}
          {hasTasks && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-[10px]">{d.taskCount}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Expanded card rendered at zoom > 1.2 (~240px wide). */
export function AgentExpandedCard({ d }: { d: AgentDemoData }) {
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasTasks = d.taskCount != null && d.taskCount > 0;

  return (
    <div
      className="bg-card w-[240px] rounded-lg border px-3 py-2 shadow-sm"
      style={d.borderColor ? { borderLeft: `3px solid ${d.borderColor}` } : undefined}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar
          color={d.avatarColor}
          emoji={d.emoji}
          healthStatus={d.healthStatus}
          size="sm"
        />
        <span className="text-foreground truncate text-sm font-medium">{d.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {d.runtime}
        </Badge>
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
      </div>
      {d.description && (
        <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs">{d.description}</p>
      )}
      {(hasRelay || hasTasks) && (
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2">
          {hasRelay &&
            d.relayAdapters!.map((adapter) => (
              <span key={adapter} className="flex items-center gap-0.5">
                <Zap className="size-3" />
                <span className="text-[10px]">{adapter}</span>
              </span>
            ))}
          {hasTasks && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-[10px]">{d.taskCount}</span>
            </span>
          )}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2">
        {d.lastSeenAt && <span className="text-muted-foreground text-[10px]">{d.lastSeenAt}</span>}
        {d.behavior && (
          <Badge variant="outline" className="text-[10px]">
            {d.behavior.responseMode}
          </Badge>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Mock data
 * --------------------------------------------------------------------------- */

export const AGENTS: AgentDemoData[] = [
  {
    label: 'code-reviewer',
    emoji: '🔍',
    avatarColor: '#6366f1',
    healthStatus: 'active',
    runtime: 'claude-code',
    capabilities: ['code-review', 'testing', 'docs'],
    borderColor: '#6366f1',
    description: 'Reviews pull requests and suggests improvements based on project conventions.',
    relayAdapters: ['slack'],
    taskCount: 3,
    behavior: { responseMode: 'always' },
    lastSeenAt: '2m ago',
  },
  {
    label: 'deploy-bot',
    emoji: '🚀',
    avatarColor: '#f59e0b',
    healthStatus: 'inactive',
    runtime: 'cursor',
    capabilities: ['deployment', 'monitoring'],
    borderColor: '#6366f1',
  },
  {
    label: 'data-pipeline',
    emoji: '📊',
    avatarColor: 'hsl(170, 70%, 55%)',
    healthStatus: 'stale',
    runtime: 'claude-code',
    capabilities: ['etl', 'analysis'],
    borderColor: '#f59e0b',
  },
  {
    label: 'test-runner',
    emoji: '🧪',
    avatarColor: 'hsl(280, 70%, 55%)',
    healthStatus: 'unreachable',
    runtime: 'codex',
    capabilities: ['testing'],
    borderColor: '#10b981',
  },
];
