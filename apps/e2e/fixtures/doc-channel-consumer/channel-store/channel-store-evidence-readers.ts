import type { requireOriginalConsumerRuntime } from '../channel-store.js';

type ConsumerContext = ReturnType<typeof requireOriginalConsumerRuntime>;

/** Lookup-only original approval DATA; never supplies an actor, document issuer, or grant. */
export function createOriginalApprovalBindingReader(
  context: ConsumerContext,
  isClosed: () => boolean,
  captured: Pick<ConsumerContext, 'db' | 'sessionId' | 'agentId' | 'runtime' | 'vault'>
) {
  const { db, sessionId, agentId, runtime, vault } = captured;
  return (documentId: string) => {
    if (isClosed() || db.$client.inTransaction)
      throw new Error('Original approval audit unavailable');
    const rows = db.$client
      .prepare<
        unknown[],
        { grantId: string; documentId: string; routeId: string; exactBinding: number }
      >(
        `SELECT g.grant_id AS grantId,
          g.document_id AS documentId,g.route_id AS routeId,
          (c.closed_at IS NULL AND c.scope=? AND g.target_session_id=?
            AND g.target_agent_id=? AND g.target_runtime=? AND g.opener_agent_id=c.opener_agent_id
            AND ag.status='active' AND ag.project_path=?
            AND ag.project_path=s.agent_path AND ag.runtime=s.runtime AND s.runtime=g.target_runtime
            AND g.declaration_hash=c.declaration_hash
            AND json_extract(g.approval_evidence,'$.binding.documentId')=g.document_id
            AND json_extract(g.approval_evidence,'$.binding.scope')=c.scope
            AND json_extract(g.approval_evidence,'$.binding.declarationHash')=g.declaration_hash
            AND json_extract(g.approval_evidence,'$.binding.routeHash')=g.route_hash
            AND json_extract(g.approval_evidence,'$.binding.route')=g.normalized_route
            AND json_extract(g.approval_evidence,'$.binding.target.sessionId')=g.target_session_id
            AND json_extract(g.approval_evidence,'$.binding.target.agentId')=g.target_agent_id
            AND json_extract(g.approval_evidence,'$.binding.target.runtime')=s.runtime
            AND json_extract(g.approval_evidence,'$.binding.target.agentPath')=s.agent_path
            AND json_extract(g.approval_evidence,'$.binding.target.scope')=c.scope
            AND json_extract(g.approval_evidence,'$.binding.allowedTypes')=g.allowed_types
            AND json_extract(g.approval_evidence,'$.binding.expiresAt')=g.expires_at
            AND json_extract(g.approval_evidence,'$.kind')='operator_approval'
            AND json_extract(g.approval_evidence,'$.approvalId')=a.id
            AND json_extract(g.approval_evidence,'$.inputHash')=a.input_hash
            AND a.consumed_at IS NOT NULL) AS exactBinding
          FROM canvas_doc_grants g JOIN canvas_doc_channels c ON c.document_id=g.document_id
          JOIN approvals a ON a.id=g.approval_id
          JOIN session_metadata s ON s.session_id=g.target_session_id
          JOIN agents ag ON ag.id=g.target_agent_id WHERE g.document_id=?
          ORDER BY g.grant_id LIMIT 201`
      )
      .all(context.scope, sessionId, agentId, runtime.type, vault.root, documentId);
    if (isClosed() || rows.length > 200) throw new Error('Original approval audit bound');
    return rows.map(({ grantId, documentId, routeId, exactBinding }) => ({
      grantId,
      documentId,
      routeId,
      exactBinding: exactBinding === 1,
    }));
  };
}

/** Lookup-only original Room replay and scenario DATA; no issuer or native stream registration. */
export function createOriginalRoomScenarioDataReader(
  context: ConsumerContext,
  captured: Pick<
    ConsumerContext,
    | 'hostBootstrap'
    | 'target'
    | 'replayServiceCurrentDoc'
    | 'readServiceOriginalRoomScenarioEvidence'
    | 'http'
    | 'documentId'
    | 'actor'
    | 'resumeRecord'
    | 'originalTargetLocked'
  >
) {
  const {
    hostBootstrap,
    target,
    replayServiceCurrentDoc,
    readServiceOriginalRoomScenarioEvidence,
    http,
    documentId,
    actor,
    resumeRecord,
    originalTargetLocked,
  } = captured;
  return async () => {
    if (!hostBootstrap || target !== 'room')
      throw new Error('Owned native Room evidence unavailable');
    const replay = await replayServiceCurrentDoc(http.service, documentId, actor);
    if (replay.incarnation?.documentId !== documentId || replay.scope !== context.scope)
      throw new Error('Original current Room identity unavailable');
    const ids = [
      ...new Set(
        replay.receipts
          .flatMap((receipt) => receipt.deliveries.map((delivery) => delivery.batchId))
          .filter((id): id is string => typeof id === 'string')
      ),
    ];
    if (ids.length > 32) throw new Error('Owned native evidence census bound');
    const batches = ids.map((id) => {
      const batch = http.channels.getBatch(id);
      if (!batch || batch.documentId !== documentId || batch.routeId !== 'consumer')
        throw new Error('Original Room delivery batch unavailable');
      const evidence = readServiceOriginalRoomScenarioEvidence(
        http.service,
        documentId,
        batch.batchId,
        batch.generation
      );
      return {
        batchId: batch.batchId,
        generation: batch.generation,
        status: batch.status,
        dueAt: batch.dueAt,
        attempt: batch.attempt,
        roomAdmissionId: batch.roomAdmissionId,
        eventIds: [...batch.inputEventIds],
        evidence: evidence ?? null,
      };
    });
    return {
      documentId,
      scope: replay.scope,
      birth: replay.incarnation,
      batches,
      targetSessionId: resumeRecord.sessionId,
      targetLocked: originalTargetLocked(resumeRecord.sessionId),
      meaning: 'PROVIDER_BOUNDARY_DATA_ONLY_ABSENCE_UNKNOWN' as const,
    };
  };
}
