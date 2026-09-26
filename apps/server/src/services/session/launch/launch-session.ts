/**
 * Start (or feed) a session from one message: the path every "send this
 * message to that session" surface walks, lifted out of
 * `POST /api/sessions/:id/messages` so a second caller does not have to copy it.
 *
 * It does, in order: verify the caller-named agent against Mesh, bind a managed
 * workspace or resolve the session's directory, choose and persist the runtime
 * (the first message wins), gate the billing-account hint, and hand the message
 * to the dispatcher inside a correlation scope. It answers with the dispatcher's
 * result, or with a typed refusal the caller turns into its own error shape.
 *
 * HTTP concerns stay with the route: parsing the body, the client id header,
 * status codes and the `202` body. Power does not live here either: the caller
 * names what it is with a {@link TurnOrigin}, and `permissionSeedForOrigin`
 * decides what that is worth.
 *
 * @module services/session/launch/launch-session
 */
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { SendMessageRequest } from '@dorkos/shared/schemas';
import { readManifest } from '@dorkos/shared/manifest';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { sanitizeWorkspaceKey } from '@dorkos/shared/workspace';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { reportUsageEvent } from '../../core/usage-reporter.js';
import { recordDispatchEnd, recordDispatchStart } from '../../observability/dispatch-buffers.js';
import { getWorkspaceManager } from '../../workspace/index.js';
import {
  resolveSessionCwdWithRoom,
  type RoomSessionPlacePort,
} from '../../workspace/room-session-cwd.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logError, logger } from '../../../lib/logger.js';
import { runInDispatch } from '../../../lib/dispatch-context.js';
import { dispatchMessage, type MessageDispatchResult } from '../message-dispatcher.js';
import { getOrCreateProjector } from '../session-state-projector.js';
import { persistenceModeFor } from '../projector-persistence.js';
import type { TurnOrigin } from '../origin/turn-origin.js';

/** What {@link dispatchSessionMessage} needs to start or feed one session. */
export interface DispatchSessionMessageOpts {
  /** The session the message is for, as the caller named it. */
  sessionId: string;
  /** The parsed message request: the same fields `POST /:id/messages` accepts. */
  request: SendMessageRequest;
  /** The client the message came from; it keys the session's write lock. */
  clientId: string;
  /** Mesh, when it is running. A caller-named `agentPath` is checked against it. */
  meshCore: MeshCore | undefined;
  /** The room binding port, so a room's conversation resumes in the room's directory. */
  roomSessionPlace: RoomSessionPlacePort | undefined;
  /**
   * What is starting this session. Required, never defaulted: it is what decides
   * the power a new session row is born with (DOR-2105).
   */
  origin: TurnOrigin;
  /**
   * Fires once, when the detached turn this message started (or joined the
   * queue for) ends. Called after the dispatch buffer records the end.
   */
  onSettled?: (outcome: 'ok' | 'failed') => void;
}

/**
 * Why {@link dispatchSessionMessage} started nothing. Each code maps to one of
 * the route's existing `400` answers, with the same message.
 */
export interface SessionLaunchRefusal {
  /** Which check refused the launch. */
  refused: 'INVALID_AGENT_PATH' | 'UNKNOWN_RUNTIME';
  /** The sentence a caller shows as-is. */
  message: string;
}

/** The dispatcher's result for a message that went through, or why none did. */
export type DispatchSessionMessageResult = MessageDispatchResult | SessionLaunchRefusal;

/**
 * Whether a launch was refused before anything started.
 *
 * @param result - What {@link dispatchSessionMessage} answered.
 */
export function isSessionLaunchRefusal(
  result: DispatchSessionMessageResult
): result is SessionLaunchRefusal {
  return 'refused' in result;
}

/**
 * Choose the runtime type for a newly-created session.
 *
 * Priority: explicit `body.runtime` hint > agent-manifest `runtime` field
 * (read from `<cwd>/.dork/agent.json`) > server default runtime type.
 *
 * Subsequent `POST /:id/messages` calls for the same `sessionId` do NOT
 * re-run this — `persistSessionRuntime` is first-write-wins, so the row
 * set by the first call is authoritative.
 *
 * The runtime is chosen FIRST because the other two execution defaults hang off
 * it: which model and effort a new session starts with is a per-runtime question
 * (`services/session/resolve-session-defaults.ts`), answered against the runtime
 * this returns, and seeded onto the same first write.
 */
async function resolveRuntimeTypeForNewSession(opts: {
  runtimeHint?: string;
  agentPath?: string;
  cwd?: string;
}): Promise<string> {
  if (opts.runtimeHint) return opts.runtimeHint;

  // Look for an agent manifest in the provided agentPath or cwd. Fall back
  // silently when no manifest exists or the read fails — a missing manifest
  // is not an error on the hot path.
  const manifestDir = opts.agentPath ?? opts.cwd;
  if (manifestDir) {
    try {
      const manifest = await readManifest(manifestDir);
      // The manifest names a runtime PREFERENCE — honor it only when that
      // runtime is registered in this process. Unlike the explicit body hint
      // (which 400s when unknown), an unregistered manifest runtime soft-falls
      // back to the default: the test-mode server (DORKOS_TEST_RUNTIME=true)
      // registers ONLY 'test-mode' while every manifest on disk says
      // 'claude-code' (the AgentRuntime enum has no test-mode member), so
      // without this guard no agent-seeded session can ever start there.
      if (manifest?.runtime) {
        if (runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
        logger.info('[POST /messages] manifest runtime not registered; using default', {
          manifestRuntime: manifest.runtime,
          defaultRuntime: runtimeRegistry.getDefaultType(),
          manifestDir,
        });
      }
    } catch {
      // Fall through to default
    }
  }

  return runtimeRegistry.getDefaultType();
}

/**
 * Accept one message for a session: bind it on first contact, then hand the
 * message to the dispatcher, which starts the turn now or queues it.
 *
 * Resolves once the dispatcher knows the canonical session id; the turn itself
 * runs detached and reports through the session's event stream.
 *
 * @param opts - The session, the parsed request, and who is starting it.
 * @returns The dispatcher's result, or a {@link SessionLaunchRefusal} when the
 *   named agent or runtime does not exist (nothing was started or written).
 */
export async function dispatchSessionMessage(
  opts: DispatchSessionMessageOpts
): Promise<DispatchSessionMessageResult> {
  const { sessionId, clientId, meshCore, roomSessionPlace, origin, onSettled } = opts;
  const {
    content,
    cwd,
    context,
    runtime: runtimeHint,
    account: accountHintRaw,
    agentPath,
    workspaceKey,
    workspaceProvider,
    seedContext,
    disposition,
  } = opts.request;

  // `agentPath` is durable ownership provenance, not an ordinary cwd hint. A
  // caller may name it only when Mesh currently knows that exact registered
  // agent directory. This keeps the first-write session binding authoritative
  // without letting client metadata manufacture an agent owner.
  let verifiedAgentPath: string | undefined;
  if (agentPath !== undefined) {
    const isRegistered = meshCore?.listWithPaths().some((agent) => agent.projectPath === agentPath);
    if (!isRegistered) {
      return {
        refused: 'INVALID_AGENT_PATH',
        message: 'Choose a registered agent before starting this session',
      };
    }
    verifiedAgentPath = agentPath;
  }

  // Opt-in workspace binding (DOR-84). When a workspaceKey is supplied, the
  // server provisions-or-reuses the managed workspace from the source repo
  // (`cwd`) and runs the turn with `cwd = workspace.path` + its port block.
  // Additive + resilient: with no key (or a disabled/failing manager) the turn
  // proceeds with the original cwd, byte-for-byte unchanged.
  let effectiveCwd = cwd;
  if (workspaceKey) {
    try {
      const source = cwd ?? DEFAULT_CWD;
      const projectKey = sanitizeWorkspaceKey(path.basename(source));
      const workspace = await getWorkspaceManager().ensure({
        projectKey,
        key: workspaceKey,
        source,
        provider: workspaceProvider,
      });
      effectiveCwd = workspace.path;
      logger.info('[POST /messages] bound to workspace', {
        sessionId,
        workspaceKey,
        path: workspace.path,
      });
    } catch (err) {
      logger.warn('[POST /messages] workspace binding skipped', {
        sessionId,
        workspaceKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // No unit-of-work key, so ask the precedence chain where this turn belongs
    // (`services/workspace/resolve-session-cwd.ts`). `workspaceKey` above keeps
    // its precedence deliberately: it is a per-turn statement about this piece
    // of work, which is strictly more specific than a standing per-agent
    // preference.
    //
    // The `default` rung is translated back into saying NOTHING, and that is
    // load-bearing rather than fussy. Every runtime already falls back to
    // `DEFAULT_CWD` on an absent cwd, so the turn runs in the same directory
    // either way — but `effectiveCwd` is also what stamps `projector.cwd`
    // below, overwriting whatever an `/events` subscribe put there. A turn that
    // has no opinion about its directory must not acquire one here.
    //
    // The room binding is offered to the chain rather than resolved here
    // (DOR-1624). A conversation this machine also answers in a room runs its
    // room turns in that room's worktree, so a resume from the app that took the
    // ordinary rungs would put the operator in the agent's own folder and hide
    // every uncommitted edit the agent has made in the room. The port answers
    // `null` for every other session, which leaves the chain exactly as it was.
    const resolved = await resolveSessionCwdWithRoom(
      { cwd, agentPath: verifiedAgentPath, sessionId },
      roomSessionPlace
    );
    if (resolved.rung !== 'default') effectiveCwd = resolved.cwd;
  }

  // First-message binding: choose + persist the runtime BEFORE resolving.
  // `persistSessionRuntime` binds a session that has none — including one whose
  // row a pre-launch settings change already created — and leaves an
  // already-bound session completely alone, so a later call passing a different
  // (or no) hint changes nothing. The first message wins.
  const runtimeType = await resolveRuntimeTypeForNewSession({
    runtimeHint,
    agentPath: verifiedAgentPath,
    cwd,
  });
  if (!runtimeRegistry.has(runtimeType)) {
    return { refused: 'UNKNOWN_RUNTIME', message: `Unknown runtime: ${runtimeType}` };
  }
  // The registry seeds this session's model, effort and trust stop from the
  // server defaults if this call is what BINDS it — see `resolveSessionDefaults`
  // — filling only what nobody chose, and re-checking a mode chosen before the
  // runtime was known against what this one declares. Nothing is written for a
  // session that is already bound, so a running conversation keeps whatever it
  // is running with.
  //
  // The caller's `origin` is passed through untouched: which power it unlocks is
  // `permissionSeedForOrigin`'s decision, never this module's (DOR-2105).
  const isNewSession = await runtimeRegistry.persistSessionRuntime(
    sessionId,
    runtimeType,
    origin,
    verifiedAgentPath
  );
  // Fire the anonymous `session_created` usage event exactly once, on the write
  // that binds the session (no-op unless usage telemetry is on).
  if (isNewSession)
    reportUsageEvent({ event: 'session_created', properties: { runtime: runtimeType } });

  // The billing-account launch hint, on exactly the `runtime` hint's lifecycle
  // (ADR 260821-205323, mirroring ADR-0255). It is honored only on the send that
  // CREATED this session, and only for claude-code — after launch the account is
  // a fact on disk that nothing can move (ADR 260801-204127), and no other
  // runtime has accounts at all. Anything else is ignored out loud rather than
  // silently, because the person who picked it believed it would apply.
  //
  // Whether the id NAMES a registered account is deliberately not asked here:
  // the resolver falls through an unknown id to the next rung so a launch never
  // fails over a billing setting, and a 400 here would be exactly that failure.
  let accountHint: string | undefined;
  if (accountHintRaw !== undefined) {
    if (isNewSession && runtimeType === 'claude-code') {
      accountHint = accountHintRaw;
    } else {
      logger.warn('[POST /messages] ignoring account hint', {
        sessionId,
        account: accountHintRaw,
        runtime: runtimeType,
        reason: isNewSession ? 'runtime has no accounts' : 'session already launched',
      });
    }
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);

  // One id for this whole dispatch, minted BEFORE the trigger so the line that
  // announces it already carries it and a reader can start there.
  const dispatchId = newDispatchId();
  logger.info('[POST /messages] trigger', { sessionId, contentLength: content.length, dispatchId });
  recordDispatchStart({ dispatchId, origin: 'session', sessionId });

  // The POST body's cwd is operator-chosen and authoritative — overwrite any
  // earlier stamp from a subscribe-path default (an /events connect without
  // ?cwd falls back to the workspace root, which would otherwise pin this
  // session's liveness to the wrong agent first-writer-wins).
  // Persist the completed-turn stream (DOR-189) so it survives a server
  // restart: everything for a log-backed runtime, and for the rest the narrow
  // record its own transcript cannot answer for — including the permission
  // decisions this turn was gated on. Enabling here — before the turn is fed —
  // guarantees the turn_end flush regardless of whether an /events subscribe
  // has already minted (and persistence-enabled) the projector.
  const projector = getOrCreateProjector(sessionId, effectiveCwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  if (effectiveCwd !== undefined) projector.cwd = effectiveCwd;

  // Trigger the detached turn. The projector is keyed by the client-facing id
  // (stable across the new-session remap, since the projector registry and
  // `/events` both resolve by it); the canonical id is captured for the body.
  //
  // **The scope wraps `dispatchMessage`, and that placement is the whole phase.**
  // The dispatcher CONSTRUCTS the detached generator chain and then awaits only
  // the canonical-id race, so entering the dispatch here binds the context to
  // the chain itself — an async generator created inside an ALS scope keeps
  // that scope for its whole life. The turn therefore stays correlated long
  // after this `await` resolves and the 202 has been sent (ADR-0264's `void
  // turn;`). A scope placed around the awaited race INSIDE the dispatcher would
  // expire at the 202 and correlate nothing; see
  // `routes/__tests__/sessions-dispatch-correlation.test.ts`, which fails if it
  // moves.
  const result = await runInDispatch({ dispatchId, origin: 'session' }, () =>
    dispatchMessage({
      sessionId,
      clientId,
      content,
      cwd: effectiveCwd,
      context,
      // Background this turn's opener attached to it. It rides the neutral
      // context bag, never `content`: the prompt stays the person's message
      // byte for byte, and the seed is stripped from every rendered transcript.
      ...(seedContext ? { seedContext } : {}),
      // Only ever set on the session-creating claude-code send (see above).
      ...(accountHint ? { accountHint } : {}),
      // Absent means `queue`, which is also what every disposition resolves to
      // until the native rungs land (P4). The receipt says which it was.
      ...(disposition ? { disposition } : {}),
      projector,
      runtime,
      onError: (err) => {
        logger.warn('[POST /messages] detached turn error', {
          sessionId,
          ...logError(err),
        });
      },
      // The 202 has long since gone out by the time this fires. It is the only
      // moment the server learns how a detached turn ended, which is exactly
      // what the debug buffer is asked for during an incident.
      onSettled: (outcome) => {
        recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered');
        onSettled?.(outcome);
      },
    })
  );

  if (result.queued) {
    logger.info('[POST /messages] queued behind the running turn', {
      sessionId,
      dispatchId,
      messageId: result.outcome.messageId,
      queuePosition: result.queuePosition,
    });
  }

  return result;
}
