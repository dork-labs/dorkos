/**
 * TanStack Table column definitions for the agent fleet table.
 *
 * Four columns: Agent (identity, with runtime and project as quiet secondary
 * text), Activity (what the agent last did, and when), Scheduled (tasks waiting
 * on it), and row actions.
 *
 * Runtime, Project, Status, and Sessions were columns of their own until DOR-459.
 * The first three were near-constant per row, so each was a fixed label repeated
 * down the page — three of seven columns saying nothing. Runtime and project
 * demoted into the identity cell. Sessions went away entirely: the count behind
 * it was a lifetime transcript count for one selected folder, so it was neither
 * "open" nor fleet-wide. Chat state now reaches the page through the attention
 * group a row sits in, and health through that same grouping plus the Activity
 * cell's own words — the avatar's health ring is gone (DOR-1052), because a
 * coloured ring 2px outside a coloured dot read as one signal drawn twice.
 *
 * @module features/agents-list/lib/agent-columns
 */
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowUpRight, Star, UserRound } from 'lucide-react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import type { AttentionState } from '@/layers/entities/session';
import { Badge, Button } from '@/layers/shared/ui';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { agentActivityDisplay } from './agent-activity-display';

// ---------------------------------------------------------------------------
// Extended row type — enriched in AgentsList before passing to DataTable
// ---------------------------------------------------------------------------

export interface AgentTableRow extends TopologyAgent {
  /**
   * Fleet-wide state of the chats under this agent's folder, from
   * `useAgentAttentionMap`.
   */
  chatState: AttentionState;
  /** Whether the agent is old enough for silence to be meaningful. */
  isPastOnboardingGrace: boolean;
  /** Whether this agent is the default agent. */
  isDefault: boolean;
  /**
   * How to name the person this agent belongs to — `@handle` when they have
   * one, their display name when they do not — or `null` when nothing owns it.
   *
   * Already resolved by the caller, the same way the Team card's attribution
   * is: the roster knows who owns what, and a table column that went looking
   * for it would be a second answer to a question already answered.
   *
   * `null` is a real state, not a missing one. A system agent belongs to the
   * install rather than to a person, so the cell says so.
   */
  managedBy: string | null;
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
 *
 * Every responsive decision on this table hangs off `md` (768px), the same
 * breakpoint `DataTable`'s `meta.hideOnMobile` uses, so the identity line and
 * the column set always change together.
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
      {/* No dot and no ring. This table never observes a turn, so it cannot
          honestly say "working right now" — and health, which it does know,
          the Activity cell beside this one already says in words ("Unreachable",
          "Stale", "Never active"). The disc used to draw both, sourced from the
          same hour-old heartbeat. */}
      <AgentAvatar color={color} emoji={emoji} size="xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium hover:underline">
          {getAgentDisplayName(row)}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {project ?? runtime}
          {project && <span className="hidden md:inline"> · {runtime}</span>}
        </span>
      </span>
      {row.isDefault && (
        // On a phone the star alone marks the default agent; spelling it out
        // there would squeeze the name it is meant to label.
        <Badge
          variant="outline"
          className="shrink-0 text-[10px] max-md:border-0 max-md:px-0 max-md:py-0"
        >
          <Star className="size-2.5 fill-current md:mr-0.5" />
          <span className="sr-only md:not-sr-only">Default</span>
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
  /**
   * Open a session for the given project path — resuming the agent's existing
   * conversation when one exists, minting a fresh one otherwise. Both the row
   * itself and its action button open the same door (DOR-1415).
   */
  onNavigate: (projectPath: string) => void;
  /** View an agent's profile — where everything about it is read and changed. */
  onViewProfile: (projectPath: string) => void;
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
      meta: { headClassName: 'w-[42%] md:w-[38%]', cellClassName: 'overflow-hidden' },
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

    // ── Owner attribution ── (hidden on mobile) ──────────────
    // The table answers "whose is this" in a column because it is a columnar
    // view; the cards answer it as a line under the name. Same fact, drawn the
    // way each surface reads.
    {
      id: 'managedBy',
      header: 'Managed by',
      meta: { hideOnMobile: true, headClassName: 'w-[140px]', cellClassName: 'overflow-hidden' },
      cell: ({ row }) => {
        const owner = row.original.managedBy;
        return (
          <span
            data-slot="agent-managed-by"
            className="text-muted-foreground block truncate text-xs"
          >
            {owner ?? '—'}
          </span>
        );
      },
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
            {count} {count === 1 ? 'schedule' : 'schedules'}
          </Badge>
        );
      },
    },

    // ── Actions ─────────────────────────────────────────────
    {
      id: 'actions',
      header: '',
      // Under `table-fixed` this width is the whole budget, and `TableHead`'s
      // `px-2` / `TableCell`'s `p-2` take 16px of it. Two `size-8` buttons plus
      // the 4px gap need 68px of content box, so anything under 84px pushes the
      // first button out through the cell's left edge and into the Activity
      // column's border. 88px keeps a little air.
      meta: { headClassName: 'w-[88px]' },
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
                callbacks.onNavigate(agent.projectPath ?? '');
              }}
              // It opens a SESSION — the same door the agent's row in the
              // sidebar is. "Chat with" read as "send this agent a message",
              // which is a different act on a different surface, so the label
              // now names what happens (spec `sidebar-simplification` §D2).
              // `ArrowUpRight` is this app's "takes you there" mark
              // (`SessionConnectorsGroup`); `MessageSquare` is its DM/session
              // glyph and read as the message this button does not send.
              aria-label={`Open session with ${getAgentDisplayName(agent)}`}
            >
              <ArrowUpRight className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onViewProfile(agent.projectPath ?? '');
              }}
              aria-label={`Open ${getAgentDisplayName(agent)}’s profile`}
            >
              <UserRound className="size-4" />
            </Button>
          </div>
        );
      },
    },
  ];
}
