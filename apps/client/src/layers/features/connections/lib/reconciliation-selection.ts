import type {
  ConnectorAccessLevel,
  ConnectorReconciliationGrantSelection,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';

/**
 * What one agent holds, or is set to hold: its exact revisions, and the level
 * the owner chose when there is one. Without a level the revisions are exact
 * actions, which stay exactly as picked as the app changes.
 */
export interface AgentAccessSelection {
  /** The complete revision set, sorted. */
  operationRevisionIds: string[];
  /** The chosen level, kept as the app changes (ADR 260929-071355); absent for exact actions. */
  level?: ConnectorAccessLevel;
}

/** Mutable UI selection keyed by the named agent whose complete set it represents. */
export type AgentOperationSelections = Record<string, AgentAccessSelection>;

/** Copy the server's current grants, and the level each one keeps, into deterministic UI state. */
export function selectionsFromPreview(
  preview: ConnectorReconciliationPreview
): AgentOperationSelections {
  return Object.fromEntries(
    preview.agents.map((agent) => {
      const grant = preview.currentGrants.find((current) => current.agentId === agent.agentId);
      return [
        agent.agentId,
        {
          operationRevisionIds: [...(grant?.operationRevisionIds ?? [])].sort(),
          ...(grant?.level && { level: grant.level }),
        },
      ];
    })
  );
}

/** Whether two selections are the same revisions and the same level. */
export function sameSelection(
  left: AgentAccessSelection | undefined,
  right: AgentAccessSelection | undefined
): boolean {
  const a = [...(left?.operationRevisionIds ?? [])].sort();
  const b = [...(right?.operationRevisionIds ?? [])].sort();
  return (
    left?.level === right?.level &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

/**
 * Return only named agents whose complete set or level changed.
 *
 * An unchanged agent is omitted. A changed agent with no selected revisions is
 * retained as an explicit empty replacement, which revokes its operation access.
 */
export function changedGrantSelections(
  preview: ConnectorReconciliationPreview,
  selections: AgentOperationSelections
): ConnectorReconciliationGrantSelection[] {
  const original = selectionsFromPreview(preview);
  return preview.agents.flatMap((agent) => {
    const after = selections[agent.agentId];
    if (sameSelection(original[agent.agentId], after)) return [];
    return [
      {
        agentId: agent.agentId,
        operationRevisionIds: [...(after?.operationRevisionIds ?? [])].sort(),
        ...(after?.level && { level: after.level }),
      },
    ];
  });
}
