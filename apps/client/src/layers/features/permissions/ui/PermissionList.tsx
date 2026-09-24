import { useState } from 'react';
import type {
  AgentPermissionsResponse,
  PermissionAreaEntry,
  PermissionState,
  PermissionsResponse,
} from '@dorkos/shared/permissions';
import {
  useAgentPermissions,
  useOverridingAgents,
  usePermissions,
  useSetPermission,
  type PermissionScope,
} from '@/layers/entities/permissions';
import { Skeleton } from '@/layers/shared/ui';
import { STATE_LABEL, defaultSourceText } from '../lib/permission-copy';
import { reportPermissionFailure } from '../lib/report-failure';
import { PermissionRow } from './PermissionRow';
import { ExceptionsChip } from './ExceptionsChip';
import { ApplyToOverridesDialog } from './ApplyToOverridesDialog';
import { ActionOverrides } from './ActionOverrides';
import { AgentFilesAndCommandsRow } from './FilesAndCommandsRow';

/** Props for {@link PermissionList}. */
export interface PermissionListProps {
  /** Which layer the list shows and writes: everyone, or one agent. */
  scope: PermissionScope;
}

/**
 * Every area that takes a state, in the server's order. An area can have no
 * fixed actions (Reach & secrets is reached through a setting's own input), and
 * it still shows: its state decides what those calls do.
 */
function stateAreas<T extends { kind: string }>(areas: readonly T[]): T[] {
  return areas.filter((area) => area.kind === 'state');
}

/** One default-layer row, with its exceptions chip and the apply dialog. */
function DefaultAreaRow({
  area,
  overview,
}: {
  area: PermissionAreaEntry;
  overview: PermissionsResponse;
}) {
  const write = useSetPermission({ kind: 'default' });
  const overriding = useOverridingAgents(area.id);
  const [pending, setPending] = useState<PermissionState | null>(null);

  const commit = (next: PermissionState, applyToAgents?: string[]) => {
    write.mutate(
      {
        kind: 'patch',
        areas: { [area.id]: next },
        ...(applyToAgents && applyToAgents.length > 0 ? { applyToAgents } : {}),
        surface: 'settings',
      },
      { onError: reportPermissionFailure, onSettled: () => setPending(null) }
    );
  };

  const onChange = (next: PermissionState) => {
    if (next === area.resolved.state) return;
    if (overriding.length > 0) setPending(next);
    else commit(next);
  };

  return (
    <>
      <PermissionRow
        areaId={area.id}
        label={area.label}
        description={area.description}
        floor={area.floor}
        value={area.resolved.state}
        sourceText={defaultSourceText(area.resolved.source, overview.preset)}
        onChange={onChange}
        disabled={write.isPending}
        footer={<ExceptionsChip area={area.id} areaLabel={area.label} agents={overriding} />}
        details={<ActionOverrides scope={{ kind: 'default' }} area={area} surface="settings" />}
      />
      <ApplyToOverridesDialog
        open={pending !== null}
        onCancel={() => setPending(null)}
        subject={area.label}
        next={pending ?? 'ask'}
        agents={overriding.map((e) => ({
          agentId: e.agentId,
          agentName: e.agentName,
          detail: `${STATE_LABEL[e.state]}${e.action ? ' (one action)' : ''}`,
        }))}
        affectedCount={Math.max(0, overview.agentCount - overriding.length)}
        onKeep={() => pending && commit(pending)}
        onUpdate={(ids) => pending && commit(pending, ids)}
        pending={write.isPending}
      />
    </>
  );
}

/** One agent-layer row: the agent's own state, or the default it follows. */
function AgentAreaRow({
  agentId,
  area,
}: {
  agentId: string;
  area: AgentPermissionsResponse['areas'][number];
}) {
  const write = useSetPermission({ kind: 'agent', agentId });
  const changed = area.resolved.source === 'agent-area' || area.resolved.source === 'agent-action';
  const inheritedText = changed
    ? `Everyone else: ${STATE_LABEL[area.inherited.state]}`
    : `Same as everyone (${STATE_LABEL[area.inherited.state]})`;
  // An edit to the agent's settings file that DorkOS noticed rather than made.
  // It is in effect, so the row says where it came from.
  const sourceText = area.changedOutsideAt
    ? `Changed outside DorkOS · ${inheritedText}`
    : inheritedText;
  const save = (next: PermissionState | null) =>
    write.mutate(
      { kind: 'patch', areas: { [area.id]: next }, surface: 'agent-page' },
      { onError: reportPermissionFailure }
    );

  return (
    <PermissionRow
      areaId={area.id}
      label={area.label}
      description={area.description}
      floor={area.floor}
      value={area.resolved.state}
      sourceText={sourceText}
      changed={changed}
      onChange={(next) => {
        if (next !== area.resolved.state) save(next);
      }}
      onReset={() => save(null)}
      disabled={write.isPending}
      details={
        <ActionOverrides scope={{ kind: 'agent', agentId }} area={area} surface="agent-page" />
      }
    />
  );
}

/**
 * Every permission area, for one layer: the defaults everyone follows, or one
 * agent's own settings on top of them. An agent's list starts with its Files &
 * commands row; the default layer's lives with the preset on the Settings page,
 * which owns the trust-stop setting.
 *
 * @param props - See {@link PermissionListProps}.
 */
export function PermissionList({ scope }: PermissionListProps) {
  const overview = usePermissions();
  const agent = useAgentPermissions(scope.kind === 'agent' ? scope.agentId : undefined);

  if (scope.kind === 'default') {
    if (overview.isError) {
      return <p className="text-muted-foreground text-sm">Couldn’t read the permissions.</p>;
    }
    if (!overview.data) return <Skeleton className="h-20 w-full" />;
    return (
      <div className="divide-border divide-y" data-testid="permission-list-default">
        {stateAreas(overview.data.areas).map((area) => (
          <DefaultAreaRow key={area.id} area={area} overview={overview.data} />
        ))}
      </div>
    );
  }

  if (agent.isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s permissions.</p>;
  }
  if (!agent.data) return <Skeleton className="h-20 w-full" />;
  return (
    <div className="divide-border divide-y" data-testid="permission-list-agent">
      <AgentFilesAndCommandsRow agentId={scope.agentId} files={agent.data.filesAndCommands} />
      {stateAreas(agent.data.areas).map((area) => (
        <AgentAreaRow key={area.id} agentId={scope.agentId} area={area} />
      ))}
    </div>
  );
}
