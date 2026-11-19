import { useId, useState } from 'react';
import {
  PERMISSION_AREAS,
  type AgentPermissionsResponse,
  type PermissionArea,
  type PermissionState,
} from '@dorkos/shared/permissions';
import { useAgentPermissions } from '@/layers/entities/permissions';
import {
  Badge,
  FieldCard,
  QueryErrorState,
  Skeleton,
  stopLabel,
  type BadgeTone,
} from '@/layers/shared/ui';
import { STATE_LABEL } from '../lib/permission-copy';

/** Props for {@link AgentCanDo}. */
export interface AgentCanDoProps {
  /** The agent whose list this is; without one, nothing is asked for. */
  agentId: string | undefined;
  /** Its name, for the heading. */
  agentName: string;
  /** Open the agent's Permissions page, where every level is changed. */
  onOpenPermissions?: () => void;
}

/** How many rows show before "Show all". */
const COLLAPSED_ROWS = 8;

/** A level's chip: a check for Allowed, a warning for Ask, plain for Blocked. */
const STATE_TONE: Record<PermissionState, BadgeTone> = {
  allowed: 'success',
  ask: 'warning',
  blocked: 'neutral',
};

/** The chip one area shows: its words, and the glyph that goes with them. */
interface Level {
  text: string;
  tone: BadgeTone;
}

/**
 * This agent's live level for one area, in the Permissions page's own words:
 * the state label for a state area, the dial's stop name for Files & commands.
 * `null` when the server did not answer for an area (a build older than this
 * client), so the row draws without a chip rather than with a guess.
 */
function levelFor(area: PermissionArea, permissions: AgentPermissionsResponse): Level | null {
  if (area.kind === 'trust-stop') {
    const stop = permissions.filesAndCommands.stop;
    return { text: stop ? stopLabel(stop) : 'Not set', tone: 'neutral' };
  }
  const entry = permissions.areas.find((candidate) => candidate.id === area.id);
  if (!entry) return null;
  return { text: STATE_LABEL[entry.resolved.state], tone: STATE_TONE[entry.resolved.state] };
}

/** One area: what it covers, and the level this agent has there. */
function Row({ area, level }: { area: PermissionArea; level: Level | null }) {
  return (
    <li
      className="flex items-start justify-between gap-4 px-4 py-3"
      data-area={area.id}
      data-testid={`can-do-row-${area.id}`}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{area.label}</p>
        <p className="text-muted-foreground text-sm">{area.description}</p>
      </div>
      {level ? (
        <Badge tone={level.tone} className="mt-0.5 shrink-0">
          {level.text}
        </Badge>
      ) : null}
    </li>
  );
}

/**
 * What one agent can do in DorkOS, with each area's live level (DOR-4115). One
 * row per permission area, in the Permissions page's order and with its words,
 * so the two pages cannot describe an area two ways. Read only: levels change
 * on the Permissions page, and this list follows every change there.
 *
 * @param props - See {@link AgentCanDoProps}.
 */
export function AgentCanDo({ agentId, agentName, onOpenPermissions }: AgentCanDoProps) {
  const permissions = useAgentPermissions(agentId);
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const listId = useId();
  const heading = `What ${agentName} can do`;

  if (!agentId) {
    return <p className="text-muted-foreground text-sm">Pick an agent to see what it can do.</p>;
  }

  const data = permissions.data;
  const shown = expanded ? PERMISSION_AREAS : PERMISSION_AREAS.slice(0, COLLAPSED_ROWS);

  return (
    <section
      className="space-y-2"
      aria-labelledby={headingId}
      aria-busy={!data && !permissions.isError}
      data-testid="agent-can-do"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={headingId} className="text-muted-foreground text-sm">
          {heading}
        </h3>
        {onOpenPermissions ? (
          <button
            type="button"
            onClick={onOpenPermissions}
            className="focus-ring rounded-sm py-1 text-sm underline underline-offset-4"
          >
            Change in Permissions
          </button>
        ) : null}
      </div>

      {permissions.isError && !data ? (
        <QueryErrorState
          title={`Couldn’t load what ${agentName} can do`}
          description="Check that DorkOS is running, then try again."
          onRetry={() => void permissions.refetch()}
          isRetrying={permissions.isFetching}
        />
      ) : !data ? (
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <FieldCard>
          <ul id={listId} aria-label={heading}>
            {shown.map((area) => (
              <Row key={area.id} area={area} level={levelFor(area, data)} />
            ))}
          </ul>
          {PERMISSION_AREAS.length > COLLAPSED_ROWS ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls={listId}
              className="focus-ring-inset text-muted-foreground hover:text-foreground w-full px-4 py-3 text-left text-sm transition-colors"
            >
              {expanded ? 'Show fewer' : `Show all ${PERMISSION_AREAS.length} areas`}
            </button>
          ) : null}
        </FieldCard>
      )}
    </section>
  );
}
