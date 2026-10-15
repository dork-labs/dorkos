/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed mcp controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerMcpControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    db,
    agentId,
    sessionId,
    rooms,
    approvals,
    http,
    actor,
    setMessageQueueStore,
    setPrivateSessionMessageAcceptanceService,
    adoptAcceptedPrivateMessages,
    suspendPrivateDispatches,
    getOrCreateProjector,
    queue,
    admission,
    runtime,
    originalTargetLocked,
    pumpLifetime,
  } = context;
  return {
    openOriginalMcpApp() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        context.mcpRetired ||
        context.mcpSetupWork
      )
        throw new Error('Original MCP App setup unavailable');
      context.mcpSetupWork = (async () => {
        const { createOriginalMcpAppFixture } = await import('../mcp-app-native.js');
        if (context.closed || context.mcpRetired) throw new Error('Original MCP App setup retired');
        context.mcpFixtureClosed = false;
        context.mcpAppFixture = createOriginalMcpAppFixture({
          db,
          http,
          rooms,
          runtime,
          actor,
          approvals,
          root: vault.root,
          sessionId,
          agentId,
        });
        const exact = context.mcpAppFixture;
        context.stopMcpAppFixture = async () => {
          await exact.close();
          context.mcpFixtureClosed = true;
        };
        return exact.open();
      })();
      return context.mcpSetupWork;
    },
    readOriginalMcpAppData() {
      if (context.closed || !context.mcpAppFixture || context.mcpRetired)
        throw new Error('Original MCP App audit unavailable');
      return context.mcpAppFixture.read();
    },
    emitOriginalMcpAppDownstream() {
      if (context.closed || !context.mcpAppFixture || context.mcpRetired || !context.mcpPumpStarted)
        throw new Error('Original App dispatch required');
      return context.mcpAppFixture.emitDownstream();
    },
    pumpOriginalMcpApp() {
      const mcpAppFixture = context.mcpAppFixture;
      if (
        context.closed ||
        !mcpAppFixture ||
        !admission ||
        context.mcpRetired ||
        context.mcpPumpStarted ||
        originalTargetLocked(sessionId)
      )
        throw new Error('Original App dispatch unavailable');
      context.mcpPumpStarted = true;
      context.mcpPumpWork = (async () => {
        const rows = db.$client
          .prepare(
            `SELECT batch_id AS batchId,due_at AS dueAt FROM canvas_doc_batches
            WHERE document_id=? AND route_id='mcp-app' AND status IN ('pending','waiting') LIMIT 2`
          )
          .all(mcpAppFixture.documentId()) as { batchId: string; dueAt: string }[];
        if (
          rows.length !== 1 ||
          !Number.isFinite(Date.parse(rows[0].dueAt)) ||
          Date.parse(rows[0].dueAt) > Date.now()
        )
          throw new Error('Original due App batch unavailable');
        admission.admit(rows[0].batchId);
        setMessageQueueStore(queue);
        setPrivateSessionMessageAcceptanceService(admission.acceptance);
        context.pumpInstalled = true;
        await adoptAcceptedPrivateMessages({
          sessionId,
          runtime,
          cwd: vault.root,
          projector: getOrCreateProjector(sessionId),
          privateDispatchSignal: pumpLifetime.signal,
        });
        if (context.closed || context.mcpRetired)
          throw new Error('Original App dispatcher retired');
        return { pumped: true };
      })();
      return context.mcpPumpWork;
    },
    stopOriginalMcpAppDispatch() {
      if (context.mcpRetirement) return context.mcpRetirement;
      context.mcpRetired = true;
      context.mcpRetirement = (async () => {
        let failure: { cause: unknown } | undefined;
        const attempt = async (action: () => unknown) => {
          try {
            await action();
          } catch (cause) {
            failure ??= { cause };
          }
        };
        await attempt(() => pumpLifetime.abort());
        const suspended = context.mcpPumpStarted
          ? attempt(() => suspendPrivateDispatches(pumpLifetime.signal))
          : Promise.resolve();
        const initialStop = context.stopMcpAppFixture;
        const producer = initialStop ? attempt(initialStop) : Promise.resolve();
        await Promise.all([suspended, producer]);
        if (context.mcpSetupWork) await attempt(() => context.mcpSetupWork);
        if (context.stopMcpAppFixture && context.stopMcpAppFixture !== initialStop)
          await attempt(context.stopMcpAppFixture);
        if (context.mcpPumpWork) await attempt(() => context.mcpPumpWork);
        if (failure) throw failure.cause;
      })();
      return context.mcpRetirement;
    },
    /** Two explicit fixed fixture actions. Neither accepts a principal, scope, SQL or state patch. */
  };
}
