import { useState } from 'react';
import { GATED_AREAS, getPermissionArea, type PermissionState } from '@dorkos/shared/permissions';
import { useAgentPermissions } from '@/layers/entities/permissions';
import { Badge, Skeleton, stopLabel, type BadgeTone } from '@/layers/shared/ui';
import { STATE_LABEL } from '../lib/permission-copy';

/** Props for {@link AgentCanDo}. */
export interface AgentCanDoProps {
  /** The agent whose list this is. */
  agentId: string;
  /** Its name, for the heading. */
  agentName: string;
  /** Open the agent's Permissions page, where every level is changed. */
  onOpenPermissions?: () => void;
}

/** How many rows show before "Show all". */
const COLLAPSED_ROWS = 6;

/** A level's chip colour: green for Allowed, amber for Ask, grey for Blocked. */
const STATE_TONE: Record<PermissionState, BadgeTone> = {
  allowed: 'success',
  ask: 'warning',
  blocked: 'neutral',
};

/** One row: what the agent can do there, and the chip that decides it. */
interface CanDoRow {
  id: string;
  label: string;
  description: string;
  chip: string;
  tone: BadgeTone;
}

function Row({ row }: { row: CanDoRow }) {
  return (
    <li
      className="flex items-start justify-between gap-4 py-3"
      data-testid={`can-do-row-${row.id}`}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{row.label}</p>
        <p className="text-muted-foreground text-sm">{row.description}</p>
      </div>
      <Badge tone={row.tone} className="shrink-0" data-testid={`can-do-level-${row.id}`}>
        {row.chip}
      </Badge>
    </li>
  );
}

/**
 * What one agent can do in DorkOS, in plain words, with each area's live level
 * (DOR-4115). One row per permission area in the Permissions page's order, then
 * the areas no level governs under "Set elsewhere", each chip saying what
 * decides it. The sentences are the ones the agent itself reads (DOR-4116), so
 * the person and the agent see one list. Read only: levels change on the
 * Permissions page, and this list follows every change there.
 *
 * @param props - See {@link AgentCanDoProps}.
 */
export function AgentCanDo({ agentId, agentName, onOpenPermissions }: AgentCanDoProps) {
  const permissions = useAgentPermissions(agentId);
  const [expanded, setExpanded] = useState(false);

  if (permissions.isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read what this agent can do.</p>;
  }
  if (!permissions.data) return <Skeleton className="h-20 w-full" />;

  const files = permissions.data.filesAndCommands;
  const filesArea = getPermissionArea('files');
  const levelRows: CanDoRow[] = [
    ...(filesArea
      ? [
          {
            id: filesArea.id,
            label: filesArea.label,
            description: filesArea.description,
            chip: files.stop ? stopLabel(files.stop) : 'Its own default',
            tone: 'neutral' as const,
          },
        ]
      : []),
    ...permissions.data.areas
      .filter((area) => area.kind === 'state')
      .map((area) => ({
        id: area.id,
        label: area.label,
        description: area.description,
        chip: STATE_LABEL[area.resolved.state],
        tone: STATE_TONE[area.resolved.state],
      })),
  ];
  const gatedRows: CanDoRow[] = GATED_AREAS.map((area) => ({
    id: area.id,
    label: area.label,
    description: area.description,
    chip: area.gate,
    tone: 'neutral' as const,
  }));
  const total = levelRows.length + gatedRows.length;
  const shownLevelRows = expanded ? levelRows : levelRows.slice(0, COLLAPSED_ROWS);

  return (
    <section className="space-y-1" data-testid="agent-can-do">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-muted-foreground text-sm">What {agentName} can do</h3>
        {onOpenPermissions ? (
          <button
            type="button"
            onClick={onOpenPermissions}
            className="focus-ring text-sm underline underline-offset-4"
          >
            Change in Permissions
          </button>
        ) : null}
      </div>
      <ul className="divide-border divide-y">
        {shownLevelRows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
      {expanded ? (
        <>
          <h4 className="text-muted-foreground pt-3 text-xs">Set elsewhere</h4>
          <ul className="divide-border divide-y" data-testid="can-do-set-elsewhere">
            {gatedRows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="focus-ring text-muted-foreground hover:text-foreground py-2 text-sm"
      >
        {expanded ? 'Show fewer' : `Show all ${total} areas`}
      </button>
    </section>
  );
}
