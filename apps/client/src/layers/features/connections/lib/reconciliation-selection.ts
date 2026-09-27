import type {
  ConnectorOperationClassification,
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

/**
 * Whether a quick access level includes an action of this safety
 * classification: "Read" is `read` only, "Read and write" adds `write`, and
 * no level includes `destructive`, which is only ever allowed one action at a
 * time. The one rule every level preset, and every screen describing one,
 * reads from.
 *
 * @param classification - The action's stored safety classification.
 * @param level - The quick access level.
 */
export function levelIncludes(
  classification: ConnectorOperationClassification,
  level: 'none' | 'read' | 'read-write'
): boolean {
  if (level === 'none') return false;
  return classification === 'read' || (level === 'read-write' && classification === 'write');
}

/** Exact supported revision IDs selected by a quick access level. */
export function revisionIdsForAccessLevel(
  candidates: ConnectorReconciliationCandidate[],
  level: 'none' | 'read' | 'read-write'
): string[] {
  return candidates
    .filter(
      (candidate) => candidate.supported && levelIncludes(candidate.capabilityClassification, level)
    )
    .map((candidate) => candidate.operationRevisionId)
    .sort();
}
