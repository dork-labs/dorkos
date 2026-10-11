import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import type { StreamEvent, SessionSettings, InterruptReceipt } from '@dorkos/shared/types';
import type {
  MessageOpts,
  CommandIntentOpts,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logger, logError } from '../../../lib/logger.js';
import { unwrap } from './sessions/session-mapper.js';
import { type OpenCodeSessionPatch } from './sessions/session-registry.js';
import { awaitAbortAck } from './messaging/bounded-abort.js';
import { resolveCompactionModel } from './messaging/compaction-model.js';
import type { RevokeConnectorTurnReason } from '../../connectors/runtime-principal-port.js';
import type { ActiveTurn } from './opencode-runtime.js';
import { creditsPromptModel } from './opencode-credit-model-data.js';

/**
 * Fulfill the runtime-fulfilled `compact` intent (ADR-0273) by triggering
 * OpenCode's native sidecar compaction — `client.session.summarize` carrying
 * the `{providerID, modelID}` body the sidecar requires (DOR-1668; see
 * {@link resolveCompactionModel} for why the SDK types that body as optional
 * while the server rejects its absence, and for how the model is chosen).
 * OpenCode reports the result out-of-band as `session.compacted`, which the
 * shared per-turn demux tap ({@link runOpenCodeTurn}) maps to
 * `operation_progress` done + `compact_boundary` (event-mapper.ts) and
 * {@link mapOpenCodeTurn} terminates on the trailing `session.idle`. Driving
 * it through the same turn path is REQUIRED, not optional: there is no
 * standing hub→projector subscription outside a turn, so the boundary reaches
 * the durable projector only because this generator yields it. The
 * `@opencode-ai/sdk` import stays confined to this directory (Hard Rule 2).
 * `OPENCODE_CAPABILITIES.commandIntents` gates the route before this is ever
 * called.
 */
export async function* executeCommandIntent(
  runtimeOwner: object,
  sessionId: string,
  _intent: RuntimeCommandIntentId,
  opts?: CommandIntentOpts
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  // NOTE: `opts.instructions` is deliberately ignored — `session.summarize`
  // takes no instruction parameter, so OpenCode compaction cannot be guided.
  // An honest per-runtime difference (claude-code forwards instructions).
  //
  // Settings are resolved the same way a prompt resolves them (registry →
  // persisted store), because the model DorkOS would run the next TURN on is
  // the first rung of the compaction model ladder.
  const settings = await facet.resolveTurnSettings(sessionId, opts);
  const cwd = opts?.cwd ?? facet.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
  yield* facet.runOpenCodeTurn(
    sessionId,
    cwd,
    undefined,
    async (client, ocSessionId, _d, _c, plan) => {
      const model =
        plan.mode === 'credits'
          ? creditsPromptModel(settings.model, plan)
          : await resolveCompactionModel(client, {
              ocSessionId,
              cwd,
              trackedModel: settings.model,
            });
      const summarized = await client.session.summarize({
        path: { id: ocSessionId },
        body: model,
      });
      if (summarized.error !== undefined) {
        throw new Error(`OpenCode session.summarize failed: ${JSON.stringify(summarized.error)}`);
      }
    }
  );
}

/**
 * Register a session's settings, hydrating the durable row (ADR-0260) under
 * the caller's own fields when the runtime has no memory of the session.
 * Precedence: explicit → persisted, and for `permissionMode` alone a runtime
 * default beneath both — a session always runs under SOME mode, while an
 * unstated model or fastMode is honestly just absent (the sidecar's own
 * default model, no fast mode) rather than a value this could invent.
 *
 * The ONE hydration seam, shared by the two cold entry points that need it —
 * {@link OpenCodeRuntime.updateSession} and
 * {@link OpenCodeRuntime.resolveTurnSettings} — because a session loses its
 * in-memory state on every restart and EITHER a message or a settings PATCH
 * can be the first thing to arrive afterwards. Registering only the fields a
 * caller happened to name would drop the row's siblings — a PATCH that picks
 * a model would reset an enforced `bypassPermissions` session to `default`
 * while the stored settings (and the app, reading them) kept showing the
 * operator's real choice (DOR-1152; the claude-code twin is DOR-1151).
 *
 * {@link OpenCodeRuntime.ensureSession} is a third cold path and deliberately
 * does NOT come through here: `SessionOpts.permissionMode` is REQUIRED by the
 * shared contract — "callers resolve the effective mode (per-send override →
 * persisted → runtime default) before creating" (`SessionOpts`,
 * `agent-runtime.ts`) — and its real callers do exactly that, the scheduler
 * from the task's own mode and the relay from the binding's, on an id it mints
 * one line earlier that no stored row can describe yet. Reading the store
 * there would re-derive an answer the caller had already given, or invent one
 * for a session that has no history.
 *
 * A session already tracked in memory reads nothing: its registration is the
 * live truth, and only the stated fields change.
 *
 * @param sessionId - DorkOS session id.
 * @param explicit - The fields this caller states, which outrank the stored ones.
 */
export async function registerWithPersisted(
  runtimeOwner: object,
  sessionId: string,
  explicit: OpenCodeSessionPatch = {}
): Promise<void> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const tracked = facet.registry.has(sessionId);
  const persisted = tracked ? null : await facet.settingsPort?.getSessionSettings(sessionId);
  // A tracked session keeps the mode it is running under unless this call
  // names one; a cold one is born with the persisted mode, or the default.
  const permissionMode = tracked
    ? explicit.permissionMode
    : (explicit.permissionMode ?? persisted?.permissionMode ?? 'default');
  const model = explicit.model ?? persisted?.model;
  const fastMode = explicit.fastMode ?? persisted?.fastMode;
  facet.registry.register(sessionId, {
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(explicit.cwd !== undefined ? { cwd: explicit.cwd } : {}),
  });
}

/**
 * Effective settings for one turn: per-send override → tracked session →
 * persisted store (hydrated once for untracked sessions, e.g. resume after
 * a server restart) → runtime default.
 */
export async function resolveTurnSettings(
  runtimeOwner: object,
  sessionId: string,
  opts?: MessageOpts
): Promise<SessionSettings> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  if (!facet.registry.has(sessionId)) {
    // Only the mode and cwd are stated here. A per-send `model`/`fastMode` is
    // a transient override for THIS turn (Tasks, relay) — it is applied to
    // the returned settings below and deliberately never tracked, so the
    // session keeps running on the operator's own choice afterwards.
    await facet.registerWithPersisted(sessionId, {
      permissionMode: opts?.permissionMode,
      cwd: opts?.cwd,
    });
  }
  const tracked = facet.registry.get(sessionId)!;
  const model = opts?.model ?? tracked.model;
  const fastMode = opts?.fastMode ?? tracked.fastMode;
  return {
    permissionMode: opts?.permissionMode ?? tracked.permissionMode,
    ...(model !== undefined ? { model } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

/**
 * @inheritdoc
 *
 * Auto-creates untracked sessions (the PATCH-before-first-message path, and
 * every PATCH that follows a restart) through the shared hydration seam
 * {@link OpenCodeRuntime.registerWithPersisted}, so a change to ONE setting
 * keeps the persisted others, then writes the operator's choice through the
 * durable settings store (ADR-0260) so it survives the next restart too. The
 * new mode applies to the very next permission request — enforcement reads
 * the registry live.
 *
 * `effort` is part of the shared signature and is DROPPED here — not tracked,
 * not echoed, and not written to the durable store. OpenCode's prompt API has
 * no effort field, so a persisted value could only ever be read back out at
 * the person as a setting that does nothing; storing it would make "Not
 * supported by OpenCode" false in the one place that matters (spec
 * `execution-defaults` §4).
 */
export async function updateSession(
  runtimeOwner: object,
  sessionId: string,
  opts: SessionSettings
): Promise<SessionUpdateResult> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const { effort: _unsupported, ...storable } = opts;
  // Hydrate BEFORE the write-through, so the row this reads is the one that
  // stood before this PATCH: the settings it says nothing about are exactly
  // what has to be recovered, and the ones it names outrank them anyway.
  await facet.registerWithPersisted(sessionId, storable);
  await facet.settingsPort?.saveSessionSettings(sessionId, storable);
  return { updated: true };
}

/**
 * @inheritdoc
 *
 * Aborts the in-flight turn via `POST /session/{id}/abort`, bounded by
 * {@link awaitAbortAck} (DOR-1299): a wedged sidecar drops the request the
 * same way an ended stdin drops claude-code's, and nothing then answers it,
 * ever. Past {@link INTERRUPT_ACK_TIMEOUT_MS} this gives up; see
 * {@link INTERRUPT_ACK_TIMEOUT_MS} for why there is nothing session-scoped to
 * escalate TO here.
 *
 * On the acked path the wire carries `session.error{MessageAbortedError}` +
 * `session.idle`, which the mapper normalizes to a quiet `done` —
 * user-initiated, not an error.
 *
 * **Nothing here is ever `closed`, and DorkOS does not settle a turn it did
 * not observe end** (spec `runtime-interrupt-receipts` §4.2, D6). An abort
 * that answers `false`, or that nothing answers at all, is `unconfirmed`: the
 * DorkOS-side turn stays open, Stop stays pressable, and the person is told
 * the stop was requested but not confirmed. Fabricating an end instead would
 * show a stopped turn that goes on producing text and disagrees with the
 * runtime's own store at the next hydrate — the DOR-1313 shape. Escalating by
 * killing the sidecar is not available either: it is DorkOS-managed and shared
 * by every OpenCode session on the machine (ADR-0308), so stopping one turn
 * that way would stop every other one too.
 */
export async function interruptQuery(
  runtimeOwner: object,
  sessionId: string
): Promise<InterruptReceipt> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const preparing = facet.roomPreparing.get(sessionId);
  if (preparing) preparing.retired = true;
  const turn = facet.activeTurns.get(sessionId);
  if (turn) {
    const operation = facet.custody.openCodeNativeTurns.get(turn);
    if (operation) operation.retired = true;
  }
  if (!turn)
    return preparing
      ? { outcome: 'closed', runtime: facet.type }
      : { outcome: 'not-running', reason: 'no-open-turn', runtime: facet.type };
  turn.controller.abort();
  try {
    await facet.revokeConnectorTurn(turn, 'turn_cancelled');
  } catch (err) {
    // A rejection means durable persistence failed after the port's
    // fail-closed in-process tombstone. The independent sidecar abort still
    // has to run so Stop reaches the agent; terminal teardown retries the
    // durable revoke because the rejected in-flight promise was cleared.
    logger.warn(
      '[OpenCodeRuntime] connector revocation persistence failed during interrupt; continuing with sidecar abort',
      { sessionId, ...logError(err) }
    );
  }
  if (turn.phase !== 'running') {
    logger.debug('[OpenCodeRuntime] cancelled turn before sidecar trigger', {
      sessionId,
    });
    return { outcome: 'closed', runtime: facet.type };
  }
  const ack = await awaitAbortAck(async () => {
    const client = await facet.provider.getClient(turn.cwd);
    const original = facet.custody.openCodeNativeTurns.get(turn);
    if (
      !original ||
      client !== original.client ||
      facet.custody.nativeMapGet.call(original.active, original.key) !== turn
    )
      return false;
    return (
      unwrap(await client.session.abort({ path: { id: turn.ocSessionId } }), 'session.abort') ===
      true
    );
  });
  // The tri-state is worth telling apart in the log: REFUSED means the
  // sidecar answered and said no (a bug or a race, not a wedge); UNACKED
  // means the bound itself fired, which is the wedge this whole path
  // exists for.
  switch (ack.kind) {
    case 'settled':
      if (ack.aborted) {
        logger.debug('[OpenCodeRuntime] interrupted in-flight turn', { sessionId });
        return { outcome: 'acked', runtime: facet.type };
      }
      logger.warn('[OpenCodeRuntime] interrupt returned false', { sessionId });
      return { outcome: 'unconfirmed', reason: 'runtime-declined', runtime: facet.type };
    case 'refused':
      // The call itself blew up — the sidecar is down, or the network is. The
      // turn is untouched and nothing DorkOS did ended it, which is `failed`
      // rather than `unconfirmed`: this one reads as an error and asks the
      // person to try again.
      logger.warn('[OpenCodeRuntime] interrupt call failed', { sessionId });
      return { outcome: 'failed', reason: 'delivery-failed', runtime: facet.type };
    case 'unacked':
      logger.warn('[OpenCodeRuntime] interrupt timed out waiting for an ack', { sessionId });
      return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: facet.type };
  }
}

/**
 * Revoke one connector binding at most once concurrently across interrupt and
 * teardown. A rejected persistence attempt is cleared so terminal teardown can
 * retry; the principal port has already tombstoned the bearer before rejecting.
 *
 * @param turn - Active turn carrying the optional binding.
 * @param reason - First terminal reason observed for that binding.
 */
export async function revokeConnectorTurn(
  runtimeOwner: object,
  turn: ActiveTurn,
  reason: RevokeConnectorTurnReason
): Promise<void> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  if (!turn.connectorBinding || !facet.connectorRuntimeTools) return;
  if (turn.connectorRevocation) return turn.connectorRevocation;

  const bindingId = turn.connectorBinding.bindingId;
  const principals = facet.connectorRuntimeTools.principals;
  const revocation = Promise.resolve().then(() => principals.revoke(bindingId, reason));
  turn.connectorRevocation = revocation;
  try {
    await revocation;
  } catch (err) {
    if (turn.connectorRevocation === revocation) turn.connectorRevocation = undefined;
    throw err;
  }
}
