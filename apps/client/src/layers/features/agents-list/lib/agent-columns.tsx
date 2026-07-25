/**
 * TanStack Table column definitions for the agent fleet table.
 *
 * Four columns: Agent (identity, with runtime and project as quiet secondary
 * text), Activity (what the agent last did, and when), Scheduled (tasks waiting
 * on it), and row actions.
 *
 * Runtime, Project, Status, and Sessions were columns of their own until DOR-459.
 * All four were near-constant per row, so each was a fixed label repeated down
 * the page — three of seven columns saying nothing. Runtime and project demoted
 * into the identity cell, sessions into the Activity cell's second line, and
 * health is now carried by the attention group a row sits in (plus the avatar's
 * health ring), which is a stronger read than the word "Stale" in a cell.
 *
 * @module features/agents-list/lib/agent-columns
 */
import type { ColumnDef } from '@tanstack/react-table';
import { MessageSquare, Settings, Star } from 'lucide-react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { agentActivityDisplay } from './agent-activity-display';

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
// Cell helpers
// ---------------------------------------------------------------------------

/**
 * Shorten a project path to its last two segments, so the cell shows the part
 * that distinguishes one agent from another rather than a shared home prefix.
 *
 * @param path - Absolute project path, or undefined when the agent has none.
 */
function shortProjectPath(path: string | undefined): string | null {
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  return segments.length <= 2 ? path : segments.slice(-2).join('/');
}

/**
 * Agent name, with the project it works in and the runtime it runs on
 * underneath — the two columns this table used to spend width on.
 *
 * The project leads because it is what distinguishes one agent from another,
 * while a fleet usually runs one or two runtimes; on a phone the runtime drops
 * off entirely rather than truncating the project that identifies the agent.
 */
function IdentityCell({ row, onOpen }: { row: AgentTableRow; onOpen: () => void }) {
  const { color, emoji } = resolveAgentVisual(row);
  const project = shortProjectPath(row.projectPath);
  const runtime = getRuntimeDescriptor(row.runtime).label;
  return (
    <button
      type="button"
      // `w-full` is load-bearing: without it the button sizes to its content and
      // spills past the fixed-width cell, so the truncation never engages.
      className="flex w-full min-w-0 items-center gap-2 text-left"
      onClick={onOpen}
    >
      <AgentAvatar color={color} emoji={emoji} size="xs" healthStatus={row.healthStatus} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium hover:underline">
          {getAgentDisplayName(row)}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {project ?? runtime}
          {project && <span className="hidden sm:inline"> · {runtime}</span>}
        </span>
      </span>
      {row.isDefault && (
        // On a phone the star alone marks the default agent; spelling it out
        // there would squeeze the name it is meant to label.
        <Badge
          variant="outline"
          className="shrink-0 text-[10px] max-sm:border-0 max-sm:px-0 max-sm:py-0"
        >
          <Star className="size-2.5 fill-current sm:mr-0.5" />
          <span className="sr-only sm:not-sr-only">Default</span>
        </Badge>
      )}
    </button>
  );
}

/** What the agent last did, with when it happened underneath. */
function ActivityCell({ row }: { row: AgentTableRow }) {
  const { primary, secondary, toneClass } = agentActivityDisplay(row);
  return (
    <span className="block min-w-0">
      <span className={cn('block truncate text-sm', toneClass)}>{primary}</span>
      {secondary && (
        <span className="text-muted-foreground block truncate text-xs tabular-nums">
          {secondary}
        </span>
      )}
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
      meta: { headClassName: 'w-[42%] sm:w-[38%]', cellClassName: 'overflow-hidden' },
      cell: ({ row }) => (
        <IdentityCell
          row={row.original}
          onOpen={() => callbacks.onNavigate(row.original.projectPath ?? '')}
        />
      ),
    },

    // ── Activity ─────────────────────────────────────────────
    {
      accessorKey: 'lastSeenEvent',
      header: 'Activity',
      cell: ({ row }) => <ActivityCell row={row.original} />,
    },

    // ── Scheduled tasks ── (hidden on mobile) ────────────────
    // The one column that still hides on a phone. At 375px the identity and
    // activity cells need every pixel, and a schedule count is the least urgent
    // of the three — it is still one tap away in the agent's own panel.
    {
      accessorKey: 'taskCount',
      header: 'Scheduled',
      meta: { hideOnMobile: true, headClassName: 'w-[110px]' },
      cell: ({ row }) => {
        const count = row.original.taskCount;
        if (count === 0) return <span className="text-muted-foreground text-xs">—</span>;
        return (
          <Badge variant="outline" className="text-xs whitespace-nowrap">
            {count} {count === 1 ? 'task' : 'tasks'}
          </Badge>
        );
      },
    },

    // ── Actions ─────────────────────────────────────────────
    {
      id: 'actions',
      header: '',
      meta: { headClassName: 'w-[76px]' },
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
