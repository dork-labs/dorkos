import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Table, TableBody } from '@/layers/shared/ui';
import { sessionHref } from '@/layers/shared/lib';
import { auditEventToRow, type ActivityRowItem } from '@/layers/entities/activity';
import {
  ActivityRow,
  ActivityViewToggle,
  type ActivityView,
} from '@/layers/features/activity-feed-page';
import type { AuditEvent } from '@dorkos/shared/audit-schemas';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Activity feed rows: one that opens a chat, one with nowhere to go. */
const FEED_ROWS: ActivityRowItem[] = [
  {
    id: 'act-1',
    occurredAt: minutesAgo(4),
    actorType: 'agent',
    actorLabel: 'Scout',
    summary: 'Finished the weekly dependency check',
    linkPath: sessionHref({ session: 'sess-1' }),
  },
  {
    id: 'act-2',
    occurredAt: minutesAgo(40),
    actorType: 'tasks',
    actorLabel: 'Schedules',
    summary: 'Ran “Morning briefing”',
    linkPath: null,
  },
];

/** Audit events, read through the same mapping the All actions view uses. */
const AUDIT_EVENTS = [
  {
    seq: 12,
    id: 'aud-12',
    at: minutesAgo(2),
    spaceId: null,
    actor: { accountId: 'agent-warden', kind: 'agent', name: 'Warden' },
    source: { surface: 'runtime-tool', sessionId: 'sess-2' },
    action: 'runtime.tool_used',
    operation: 'execute',
    target: null,
    outcome: 'ok',
    summary: 'Warden ran `pnpm test` in dorkos',
    visibility: 'space',
    prevHash: '',
    hash: '',
  },
  {
    seq: 11,
    id: 'aud-11',
    at: minutesAgo(15),
    spaceId: null,
    actor: { accountId: 'person-dorian', kind: 'person', name: 'Dorian' },
    source: { surface: 'app' },
    action: 'config.changed',
    operation: 'modify',
    target: { type: 'config', id: 'agents.defaultAgent' },
    outcome: 'ok',
    summary: 'Dorian changed the default agent to Warden',
    visibility: 'space',
    prevHash: '',
    hash: '',
  },
  {
    seq: 10,
    id: 'aud-10',
    at: minutesAgo(30),
    spaceId: null,
    actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
    source: { surface: 'system' },
    action: 'mcp.mesh_unregister',
    operation: 'remove',
    target: { type: 'agent', id: 'agent-scout', name: 'Scout' },
    outcome: 'refused',
    summary: 'Unregistering Scout was refused: it needs approval',
    visibility: 'space',
    prevHash: '',
    hash: '',
  },
] as AuditEvent[];

const AUDIT_ROWS = AUDIT_EVENTS.map(auditEventToRow);

/** The rows both Activity lists and an agent's profile timeline draw. */
function RowTable({ rows, compact = false }: { rows: ActivityRowItem[]; compact?: boolean }) {
  return (
    <Table>
      <TableBody>
        {rows.map((row) => (
          <ActivityRow key={row.id} item={row} compact={compact} />
        ))}
      </TableBody>
    </Table>
  );
}

/** Activity rows and the toggle between the Activity feed and every recorded action. */
export function ActivityShowcases() {
  const [view, setView] = useState<ActivityView>('activity');

  return (
    <>
      <PlaygroundSection
        title="ActivityRow"
        description="One row of the Activity page, the All actions view and an agent's profile timeline. A row opens only when it has somewhere to go."
      >
        <ShowcaseLabel>Activity feed</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <RowTable rows={FEED_ROWS} />
        </ShowcaseDemo>
        <ShowcaseLabel>All actions (audit events)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <RowTable rows={AUDIT_ROWS} />
        </ShowcaseDemo>
        <ShowcaseLabel>Compact (profile timeline)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-sm">
            <RowTable rows={AUDIT_ROWS} compact />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ActivityViewToggle"
        description="Switches the Activity page between its feed and every recorded action."
      >
        <ShowcaseDemo>
          <ActivityViewToggle view={view} onViewChange={setView} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
