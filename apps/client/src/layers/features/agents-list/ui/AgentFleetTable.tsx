import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { DataTable } from '@/layers/shared/ui/data-table';
import {
  ATTENTION_GROUP_DISPLAY,
  resolveAgentAttention,
  type AgentAttentionGroup,
} from '../lib/agent-attention';
import {
  createAgentColumns,
  type AgentColumnCallbacks,
  type AgentTableRow,
} from '../lib/agent-columns';

/** Header row content for one attention group. */
function AttentionGroupHeader({ group, count }: { group: AgentAttentionGroup; count: number }) {
  const { label, toneClass } = ATTENTION_GROUP_DISPLAY[group];
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
      {group === 'needs-you' && <AlertTriangle className={cn('size-3.5', toneClass)} />}
      <span className={toneClass}>{label}</span>
      <span className="text-muted-foreground font-normal tabular-nums">{count}</span>
    </span>
  );
}

interface AgentFleetTableProps {
  /** Rows in the order they should render. */
  rows: AgentTableRow[];
  /**
   * When true, rows are labelled with their attention group. Requires `rows` to
   * already be in attention order; a user-chosen field sort passes false so the
   * groups flatten instead of fighting the sort.
   */
  grouped: boolean;
  /** Row-action handlers passed through to the column cells. */
  callbacks: AgentColumnCallbacks;
}

/**
 * The agent fleet table — the columnar half of `/agents`, without the filter bar.
 *
 * Rendered by {@link AgentsList} with live data and by the dev playground with
 * mock rows, so both show the same component.
 */
export function AgentFleetTable({ rows, grouped, callbacks }: AgentFleetTableProps) {
  const columns = useMemo(() => createAgentColumns(callbacks), [callbacks]);

  const groupBy = useMemo(
    () =>
      grouped
        ? {
            key: (row: AgentTableRow) => resolveAgentAttention(row).group,
            header: (key: string, count: number) => (
              <AttentionGroupHeader group={key as AgentAttentionGroup} count={count} />
            ),
          }
        : undefined,
    [grouped]
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      groupBy={groupBy}
      emptyMessage="No agents registered."
      className="border-0"
      // Fixed layout so the identity and activity cells truncate instead of
      // pushing the row wider than the screen.
      tableClassName="table-fixed"
    />
  );
}
