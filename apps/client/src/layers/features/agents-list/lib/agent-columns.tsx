/**
 * TanStack Table column definitions for the agent fleet table.
 *
 * Columns: Agent (identity), Status, Runtime, Project, Sessions, Last Seen, Actions.
 * Runtime, Project, and Sessions columns are hidden on mobile via `meta.hideOnMobile`.
 *
 * @module features/agents-list/lib/agent-columns
 */
import type { ColumnDef } from '@tanstack/react-table';
import { MessageSquare, Settings, Star } from 'lucide-react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { agentStatusDisplay, lastSeenLabel } from './agent-health-display';

// ---------------------------------------------------------------------------
// Extended row type — enriched in AgentsList before passing to DataTable
// ---------------------------------------------------------------------------

export interface AgentTableRow extends TopologyAgent {
  /** Number of active sessions for this agent's project path. */
  sessionCount: number;
  /** Whether this agent is the default agent. */
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/** Compact health status indicator with colored dot and label. */
function HealthStatus({ row }: { row: AgentTableRow }) {
  const cfg = agentStatusDisplay(row.healthStatus, row.lastSeenAt);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', cfg.dotClass)} />
      <span className="text-muted-foreground text-xs">{cfg.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Column factory
// ---------------------------------------------------------------------------

export interface AgentColumnCallbacks {
  /** Navigate to a session for the given project path. */
  onNavigate: (projectPath: string) => void;
  /** Open the AgentHub panel for management. */
  onManage: (projectPath: string) => void;
  /** Start a new session for an agent. */
  onStartSession: (projectPath: string) => void;
}

/** Create column definitions for the agent fleet table. */
export function createAgentColumns(
  callbacks: AgentColumnCallbacks
): ColumnDef<AgentTableRow, unknown>[] {
  return [
    // ── Agent identity ────────────────────────────────────────
    {
      accessorKey: 'name',
      header: 'Agent',
      cell: ({ row }) => {
        const agent = row.original;
        const { color, emoji } = resolveAgentVisual(agent);
        return (
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => callbacks.onNavigate(agent.projectPath ?? '')}
          >
            <AgentAvatar color={color} emoji={emoji} size="xs" healthStatus={agent.healthStatus} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium hover:underline">
                {getAgentDisplayName(agent)}
              </span>
              {agent.description && (
                <span className="text-muted-foreground block max-w-[300px] truncate text-xs max-sm:hidden">
                  {agent.description}
                </span>
              )}
            </span>
            {agent.isDefault && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                <Star className="mr-0.5 size-2.5 fill-current" />
                Default
              </Badge>
            )}
          </button>
        );
      },
    },

    // ── Health status ────────────────────────────────────────
    {
      accessorKey: 'healthStatus',
      header: 'Status',
      cell: ({ row }) => <HealthStatus row={row.original} />,
    },

    // ── Runtime ── (hidden on mobile) ───────────────────────
    {
      accessorKey: 'runtime',
      header: 'Runtime',
      meta: { hideOnMobile: true },
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-xs">
          {row.original.runtime}
        </Badge>
      ),
    },

    // ── Project path ── (hidden on mobile) ──────────────────
    {
      accessorKey: 'projectPath',
      header: 'Project',
      meta: { hideOnMobile: true },
      cell: ({ row }) => {
        const path = row.original.projectPath;
        if (!path) return <span className="text-muted-foreground text-xs">—</span>;
        const segments = path.split('/').filter(Boolean);
        const display = segments.length <= 2 ? path : segments.slice(-2).join('/');
        return (
          <span className="text-muted-foreground max-w-[200px] truncate font-mono text-xs">
            {display}
          </span>
        );
      },
    },

    // ── Session count ── (hidden on mobile) ─────────────────
    {
      accessorKey: 'sessionCount',
      header: 'Sessions',
      meta: { hideOnMobile: true },
      cell: ({ row }) => {
        const count = row.original.sessionCount;
        if (count === 0) return <span className="text-muted-foreground text-xs">—</span>;
        return (
          <Badge variant="outline" className="text-xs">
            {count} active
          </Badge>
        );
      },
    },

    // ── Last seen ───────────────────────────────────────────
    {
      accessorKey: 'lastSeenAt',
      header: 'Last Seen',
      cell: ({ row }) => {
        const { lastSeenAt, healthStatus } = row.original;
        // A never-active agent reads as "New", not the alarming "Never".
        return (
          <span className="text-muted-foreground text-xs tabular-nums">
            {lastSeenLabel(healthStatus, lastSeenAt)}
          </span>
        );
      },
    },

    // ── Actions ─────────────────────────────────────────────
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onStartSession(agent.projectPath ?? '');
              }}
              aria-label={`Chat with ${getAgentDisplayName(agent)}`}
            >
              <MessageSquare className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onManage(agent.projectPath ?? '');
              }}
              aria-label={`Manage ${getAgentDisplayName(agent)}`}
            >
              <Settings className="size-4" />
            </Button>
          </div>
        );
      },
    },
  ];
}
