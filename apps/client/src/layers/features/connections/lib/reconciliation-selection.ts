import type {
  ConnectorReconciliationCandidate,
  ConnectorReconciliationGrantSelection,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';

/** Mutable UI selection keyed by the named agent whose complete set it represents. */
export type AgentOperationSelections = Record<string, string[]>;

/** Copy the server's exact current grants into deterministic UI state. */
export function selectionsFromPreview(
  preview: ConnectorReconciliationPreview
): AgentOperationSelections {
  return Object.fromEntries(
    preview.agents.map((agent) => [
      agent.agentId,
      [
        ...(preview.currentGrants.find((grant) => grant.agentId === agent.agentId)
          ?.operationRevisionIds ?? []),
      ].sort(),
    ])
  );
}

/**
 * Return only named agents whose complete set changed.
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
    const before = original[agent.agentId] ?? [];
    const after = [...(selections[agent.agentId] ?? [])].sort();
    if (before.length === after.length && before.every((value, index) => value === after[index])) {
      return [];
    }
    return [{ agentId: agent.agentId, operationRevisionIds: after }];
  });
}

/** Exact supported revision IDs selected by a quick access level. */
export function revisionIdsForAccessLevel(
  candidates: ConnectorReconciliationCandidate[],
  level: 'none' | 'read' | 'read-write'
): string[] {
  if (level === 'none') return [];
  return candidates
    .filter(
      (candidate) =>
        candidate.supported &&
        (candidate.capabilityClassification === 'read' ||
          (level === 'read-write' && candidate.capabilityClassification === 'write'))
    )
    .map((candidate) => candidate.operationRevisionId)
    .sort();
}
