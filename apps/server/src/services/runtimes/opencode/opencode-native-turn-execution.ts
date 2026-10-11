import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type {
  DirectoryGrant,
  SseResponse,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import { type NativeSessionAcquisition } from '../../session/session-lock.js';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';
import { logger, logError } from '../../../lib/logger.js';
import {
  createOpenCodeEventContext,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeWireEvent,
} from './events/event-mapper.js';
import { unwrap } from './sessions/session-mapper.js';
import { OpenCodeGlobalEventHub, TurnEventQueue } from './events/global-event-hub.js';
import { enforceApprovals, type ApprovalRouting } from './messaging/approvals.js';
import { STREAM_LIVE_TIMEOUT_MS } from './runtime-constants.js';
import { awaitStreamLive } from './messaging/bounded-abort.js';
import { captureOpenCodeMedia } from './events/media-capture.js';
import { connectorRuntimeHeaders, type ConnectorRuntimeMcpInjection } from '../connector-tools.js';
import type { RevokeConnectorTurnReason } from '../../connectors/runtime-principal-port.js';
import { type ConnectorTurnLease } from './mcp/connector-turn-lease.js';
import {
  OPENCODE_LABEL,
  OpenCodeSwitchPendingError,
  type OpenCodeSidecarPlan,
} from './credits-sidecar.js';
import { asCreditsStopped, creditsRefusalEvent } from '../../core/cloud/credits-protocols.js';
import { ConnectorTurnLeaseSupervisor } from '../connectors/connector-turn-lease-supervisor.js';
import type {
  ActiveTurn,
  SettingUpTurn,
  OpenCodePreparedRoomContinuation,
} from './opencode-runtime.js';

/** Run the original guarded runOpenCodeTurn operation. */
export async function* runOpenCodeTurn(
  runtimeOwner: object,
  sessionId: string,
  cwd: string,
  title: string | undefined,
  trigger: (
    client: OpencodeClient,
    ocSessionId: string,
    dorkosApplied: boolean,
    connectionsApplied: boolean,
    plan: OpenCodeSidecarPlan
  ) => Promise<void>,
  opts?: {
    connectorTurn?: boolean;
    forAgent?: string;
    grants?: readonly DirectoryGrant[];
    permissionCeiling?: TurnPermissionCeiling;
    lifetime?: {
      closed: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: OpenCodePreparedRoomContinuation;
    };
  }
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  // **Who pays** (ADR 261001-000811), decided before anything is sent: the
  // sidecar is made right for OpenCode's recorded choice, and a credits turn
  // that credits cannot pay for is REFUSED here, with nothing sent.
  // Counted as running from here, before the sidecar is prepared: a switch
  // between own sign-in and credits must not restart the sidecar under a
  // turn that is still setting up. Released once the turn is tracked as
  // active below, or when it ends before that.
  const settingUp: SettingUpTurn = { sessionId };
  facet.settingUp.add(settingUp);
  const originalPrepared = opts?.lifetime?.roomPrepared;
  let plan: OpenCodeSidecarPlan;
  let ocSessionId: string;
  let client: OpencodeClient;
  let directory: string;
  if (originalPrepared) {
    plan = originalPrepared.plan;
    ocSessionId = originalPrepared.turn.ocSessionId;
    client = originalPrepared.client;
    directory = originalPrepared.directory;
  } else {
    try {
      plan = await facet.prepareSidecar(sessionId, settingUp);
    } catch (err) {
      facet.settingUp.delete(settingUp);
      void facet.provider.turnSettled?.().catch(() => undefined);
      if (err instanceof OpenCodeSwitchPendingError) {
        yield {
          type: 'error',
          data: { message: err.message, code: err.code, category: 'execution_error' },
        };
        return;
      }
      const refusal = creditsRefusalEvent(err);
      if (!refusal) throw err;
      yield refusal;
      return;
    }
    try {
      ({ ocSessionId, client, directory } = await facet.resolveNativeClient(sessionId, cwd, title));
    } catch (err) {
      facet.settingUp.delete(settingUp);
      void facet.provider.turnSettled?.().catch(() => undefined);
      throw err;
    }
  }

  if (opts?.lifetime?.closed) {
    facet.settingUp.delete(settingUp);
    return;
  }
  const controller = originalPrepared?.turn.controller ?? new AbortController();
  const turn: ActiveTurn = originalPrepared?.turn ?? {
    ocSessionId,
    cwd,
    controller,
    phase: facet.connectorRuntimeTools ? 'waiting' : 'setup',
  };
  const { nativeOperation, nativeEntry } =
    originalPrepared ??
    facet.installNativeTurn(
      sessionId,
      directory,
      client,
      turn,
      opts?.lifetime?.acquisition,
      false,
      opts?.lifetime?.roomOrigin
    );
  if (opts?.lifetime)
    opts.lifetime.retire = () => {
      nativeEntry.retired = true;
    };
  facet.settingUp.delete(settingUp);
  let lease: ConnectorTurnLease | undefined;
  let connectorInjection: ConnectorRuntimeMcpInjection | undefined;
  let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
  let subscription: ReturnType<OpenCodeGlobalEventHub['subscribe']> | undefined;
  let stopQueueRead: (() => void) | undefined;

  let sourceFailed = false,
    sourceCause: unknown;

  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    if (stopQueueRead) controller.signal.removeEventListener('abort', stopQueueRead);
    facet.custody.openCodeOriginalReadStops.delete(turn);
    nativeEntry.retired = true;
    if (originalPrepared) {
      const cleanup = async (work: () => unknown | Promise<unknown>) => {
        try {
          await work();
        } catch (cause) {
          if (!sourceFailed) {
            sourceFailed = true;
            sourceCause = cause;
          }
        }
      };
      await cleanup(() => turn.connectorSupervisor?.stop());
      // The outer original prepared owner performs the one genuine durable revoke.
      await cleanup(() => lease?.release());
      await cleanup(() => subscription?.unsubscribe());
      if (facet.activeTurns.get(sessionId) === turn) {
        await cleanup(() => facet.approvals.clearSession(sessionId));
        facet.activeTurns.delete(sessionId);
      }
      // The outer original prepared retirement owns provider settlement once,
      // even when genuine durable revocation rejects before it.
      if (sourceFailed) throw sourceCause;
    } else {
      if (controller.signal.aborted) connectorRevokeReason = 'turn_cancelled';
      turn.connectorSupervisor?.stop();
      try {
        await facet.revokeConnectorTurn(turn, connectorRevokeReason);
      } catch (err) {
        // The principal port invalidates the bearer in-process before a durable
        // write can reject. Contain persistence failure here so the terminal
        // stream still settles and the safely tombstoned directory can hand off.
        logger.warn('[OpenCodeRuntime] connector revocation persistence failed at teardown', {
          sessionId,
          ...logError(err),
        });
      } finally {
        lease?.release();
        subscription?.unsubscribe();
        // Identity guard: only the session's ACTIVE turn may tear down shared
        // per-session state. A stale turn racing a newer one must clear neither
        // the newer turn's record nor its pending approvals — unconditionally
        // clearing would disarm the newer turn's auto-deny timers and dead-end
        // its approveTool() calls.
        if (facet.activeTurns.get(sessionId) === turn) {
          facet.approvals.clearSession(sessionId);
          facet.activeTurns.delete(sessionId);
        }
        // A Runs on switch that waited for running turns may happen now.
        void facet.provider.turnSettled?.().catch((err) => {
          logger.warn(
            '[OpenCodeRuntime] could not apply the waiting Runs on switch',
            logError(err)
          );
        });
      }
    }
  };
  try {
    // Once connector tools are installed, every path below can reconcile a
    // directory map that contains session-bound connector state. Hold the
    // same canonical-directory lease for the whole turn so an unbound path
    // such as compaction cannot remove or replace another live turn's
    // registration. There is exactly one acquisition per turn, which also
    // keeps waiting visible and cancellable. Installs without connector tools
    // retain the runtime's established same-session overlap behavior.
    if (facet.connectorRuntimeTools) {
      lease = await facet.connectorLeases.acquire(directory, controller.signal);
      turn.phase = 'setup';
    }

    // Whose identity this turn carries: the directory's own agent, or the one
    // a room worktree was handed to — never by prefix, and never another agent
    // than the room turn names (DOR-2091, `agent-home.ts`). A worktree
    // looked up exactly hosts nobody, which is how opencode agents in a room
    // with files used to get no `dorkos` server at all.
    const agentPath = homeOf(resolveAgentHome(cwd, opts?.forAgent));
    const meshAgent =
      opts?.connectorTurn && agentPath ? facet.meshCore?.getByPath(agentPath) : undefined;
    nativeEntry.agentPath = agentPath;
    if (facet.connectorRuntimeTools && meshAgent && agentPath) {
      turn.connectorBinding =
        turn.connectorBinding ??
        (await facet.connectorRuntimeTools.principals.openTurn(
          {
            runtime: facet.type,
            canonicalSessionId: sessionId,
            agentPath,
            canonicalCwd: directory,
            signal: controller.signal,
          },
          { isCurrent: () => facet.activeTurns.get(sessionId) === turn, nativeOperation }
        ));
      controller.signal.throwIfAborted();
      connectorInjection = {
        url: facet.connectorRuntimeTools.listenerUrl,
        agentToolsUrl: facet.connectorRuntimeTools.agentToolsUrl,
        headers: connectorRuntimeHeaders({
          bearer: turn.connectorBinding.bearer,
          runtime: facet.type,
          canonicalCwd: directory,
        }),
      };
    }

    // Registration and the lease use the sidecar's canonical directory. The
    // anchored agent path is the agent lookup key — the original cwd when it
    // anchors to itself, which also covers symlinks that differ — and `null`
    // when the turn anchors to nobody, so a refused turn standing in another
    // agent's folder is given none of that agent's servers.
    const mcpResult = await facet.mcp.ensureManaged(
      client,
      directory,
      connectorInjection,
      agentPath ?? null
    );
    if (connectorInjection && !mcpResult.connectorApplied) {
      if (originalPrepared) {
        await originalPrepared.retire();
        throw new Error('Original prepared connector setup refused.');
      }
      await facet.revokeConnectorTurn(turn, 'setup_failed');
    } else if (turn.connectorBinding && facet.connectorRuntimeTools) {
      const createSupervisor =
        facet.connectorRuntimeTools.createLeaseSupervisor ??
        ((options) => new ConnectorTurnLeaseSupervisor(options));
      turn.connectorSupervisor = createSupervisor({
        principals: facet.connectorRuntimeTools.principals,
        bindingId: turn.connectorBinding.bindingId,
        permit: turn.connectorBinding.renewalPermit,
        runtime: facet.type,
        expiresAt: turn.connectorBinding.expiresAt,
        signal: controller.signal,
        onLost: (loss) => logger.warn('[OpenCodeRuntime] Connections lease lost', loss),
      });
    }
    controller.signal.throwIfAborted();

    const ctx = createOpenCodeEventContext(sessionId);
    // Read the model catalog now, so the reply's context reading finds its
    // window ready rather than waiting on it (bounded either way).
    facet.contextWindows.prefetch(client, directory);
    const queue = new TurnEventQueue<OpenCodeWireEvent>();
    if (originalPrepared) {
      stopQueueRead = () => queue.fail(controller.signal.reason);
      controller.signal.addEventListener('abort', stopQueueRead, { once: true });
      if (controller.signal.aborted) stopQueueRead();
      facet.custody.openCodeOriginalReadStops.set(turn, async () => {
        const stopped = unwrap(
          await client.session.abort({ path: { id: ocSessionId } }),
          'session.abort'
        );
        if (stopped !== true) throw new Error('Original Room sidecar abort unconfirmed.');
      });
    }
    subscription = facet.hub.subscribe({
      cwd,
      onEvent: (event) => {
        // The turn's own session, plus any child session a `task` tool part has
        // revealed — that is how a subagent's activity reaches its parent card.
        const admit =
          matchesOpenCodeSession(event, directory, ocSessionId) ||
          matchesOpenCodeSubagentSession(event, directory, ctx);
        if (admit) queue.push(event.payload as OpenCodeWireEvent);
      },
      onStreamDrop: (error) => queue.fail(error),
    });

    turn.phase = 'running';
    connectorRevokeReason = 'runtime_failed';
    let sawRuntimeError = false;
    // Trigger only once the stream is observably live (or the bounded wait
    // elapses) — a fast turn must not complete before we can see its idle.
    await awaitStreamLive(subscription.live, STREAM_LIVE_TIMEOUT_MS);

    controller.signal.throwIfAborted();
    await trigger(client, ocSessionId, mcpResult.dorkosApplied, mcpResult.connectorApplied, plan);

    const routing: ApprovalRouting = {
      sessionId,
      ocSessionId,
      cwd,
      permissions: ctx,
      ...(opts?.grants ? { grants: opts.grants } : {}),
      ...(opts?.permissionCeiling !== undefined
        ? { permissionCeiling: opts.permissionCeiling }
        : {}),
    };
    for await (const mapped of mapOpenCodeTurn(queue, ctx)) {
      // On credits, a refused token is the credits card, never an OpenCode
      // sign-in error: the person's own sign-in was not used.
      const event = await facet.withContextWindow(
        client,
        directory,
        ctx.providerId,
        plan.mode === 'credits' ? asCreditsStopped(mapped, OPENCODE_LABEL) : mapped
      );
      if (event.type === 'error') sawRuntimeError = true;
      yield* enforceApprovals(facet.approvalGate, routing, event);
      // The async half of media mapping. `mapOpenCodeTurn` is pure and cannot
      // store bytes, so it records what it saw on `ctx` and this drains it
      // here — after the event it rode in on, so an image lands in the
      // transcript exactly where the tool result that produced it did.
      yield* captureOpenCodeMedia(facet.attachments, sessionId, ctx);
    }
    connectorRevokeReason = sawRuntimeError ? 'runtime_failed' : 'turn_terminal';
  } catch (cause) {
    if (!originalPrepared) throw cause;
    sourceFailed = true;
    sourceCause = cause;
  } finally {
    await drainOriginalCleanup();
  }
}

/**
 * Add the model's context window to a reply's context reading, so the
 * reading says how full the conversation is (DOR-2732). OpenCode's own
 * usage event names the model but not its window; the sidecar's catalog
 * does ({@link OpenCodeContextWindows}, cached per directory, waited on for
 * at most `CONTEXT_WINDOW_READ_TIMEOUT_MS`). A model the catalog gives no
 * window for, or a catalog that does not answer in time, leaves the reading
 * without one.
 *
 * @param client - The sidecar client the turn runs on.
 * @param directory - The session's directory, for the catalog read.
 * @param providerId - The reply's provider, as the mapper recorded it.
 * @param event - One mapped event; only a context reading is touched.
 */
export async function withContextWindow(
  runtimeOwner: object,
  client: OpencodeClient,
  directory: string,
  providerId: string | undefined,
  event: StreamEvent
): Promise<StreamEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  if (event.type !== 'session_status') return event;
  const data = event.data as Record<string, unknown>;
  if (data.contextTokens === undefined || data.contextMaxTokens !== undefined) return event;
  const window = await facet.contextWindows.lookup(
    client,
    directory,
    providerId,
    typeof data.model === 'string' ? data.model : undefined
  );
  return window === undefined
    ? event
    : ({ ...event, data: { ...data, contextMaxTokens: window } } as StreamEvent);
}
