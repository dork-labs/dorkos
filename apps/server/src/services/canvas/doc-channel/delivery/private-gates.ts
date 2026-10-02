/** Current private-session gates observe capacity without acquiring a runtime slot. */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { DbTransaction } from '@dorkos/db';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocBatchRow } from '../store.js';
import { privateDocTurnBudget } from './final-budget.js';
import type { DocPumpGate, DocBatchPumpOptions } from './pump.js';
/** Registered runtime instances and current grant authority are mandatory. */
export function createPrivateDocPumpGates(options: {
  grants: DocChannelGrants;
  runtimes: { get(type: string): AgentRuntime };
  now: () => Date;
}): Pick<DocBatchPumpOptions, 'capacity' | 'budget'> {
  const wait = (reason: string): DocPumpGate => ({
    available: false,
    reason,
    nextEligibleAt: new Date(options.now().getTime() + 60_000).toISOString(),
  });
  const current = (batch: Readonly<DocBatchRow>, tx: DbTransaction) =>
    options.grants.revalidateBatchGrant(batch, tx);
  const privateTarget = (
    batch: Readonly<DocBatchRow>,
    target: ReturnType<typeof current>['target']
  ) =>
    batch.scope.startsWith('session:') &&
    target.scope === batch.scope &&
    target.sessionId === batch.scope.slice(8) &&
    !!target.agentId &&
    !!target.runtime &&
    !!target.agentPath;
  return {
    budget(batch, tx) {
      const { grant, target } = current(batch, tx);
      // These inputs stay durable until the separately typed room/Relay paths are installed.
      if (!privateTarget(batch, target)) return wait('typed_destination_unavailable');
      const decision = privateDocTurnBudget(
        {
          documentId: batch.documentId,
          batchId: batch.batchId,
          generation: batch.generation,
          routeId: batch.routeId,
          grantId: grant.grantId,
          grantRevision: grant.revision,
          scope: batch.scope,
          sessionId: target.sessionId!,
          agentId: target.agentId!,
          runtime: target.runtime!,
          agentPath: target.agentPath!,
          turnsPerHour: (grant.limits as { turnsPerHour: number }).turnsPerHour,
        },
        tx,
        options.now().toISOString()
      );
      if (decision.decision === 'defer')
        return {
          available: false,
          reason: decision.reason,
          nextEligibleAt: decision.nextEligibleAt,
        };
      if (decision.decision === 'refuse') return wait(decision.code);
      return { available: true };
    },
    capacity(batch, tx) {
      const { target } = current(batch, tx);
      if (!privateTarget(batch, target)) return wait('typed_destination_unavailable');
      let runtime: AgentRuntime;
      try {
        runtime = options.runtimes.get(target.runtime!);
      } catch {
        return wait('runtime_unavailable');
      }
      if (isTurnInFlight(target.sessionId!, runtime)) return wait('target_busy');
      if (peekProjector(target.sessionId!)?.hasPendingInteractions())
        return wait('pending_interaction');
      const internalId = runtime.getInternalSessionId(target.sessionId!) ?? target.sessionId!;
      if (
        runtime.isSegmentPending?.(target.sessionId!) ||
        (internalId !== target.sessionId && runtime.isSegmentPending?.(internalId))
      )
        return wait('pending_segment');
      return { available: true };
    },
  };
}
