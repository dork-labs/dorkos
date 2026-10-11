import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import { captureTurnLevelOptions } from '../../core/turn-power/turn-levels.js';
import { isNonFatalErrorCode } from '@dorkos/shared/run-outcome';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import {
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../core/agent-identity/index.js';
import { buildOpenCodeTurnContext } from './messaging/turn-context.js';
import {
  buildOpenCodeParts,
  buildOpenCodeSystem,
  parseModelSelection,
} from './messaging/turn-input.js';
import { validatedGrants } from './messaging/directory-grants.js';
import { OPENCODE_LABEL, openCodeRunsOnCredits } from './credits-sidecar.js';
import { creditsRefusalEvent } from '../../core/cloud/credits-protocols.js';
import {
  catalogNameFor,
  decideCreditsLaunchModel,
  type CreditsModelDecision,
} from '../../core/cloud/credits-models.js';
import type { OpenCodePreparedRoomContinuation } from './opencode-runtime.js';
import {
  creditsModelIdOf,
  creditsSelection,
  creditsPromptModel,
} from './opencode-credit-model-data.js';

/** Run the original guarded createMessage operation. */
export function createMessage(
  runtimeOwner: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  acquisition?: NativeSessionAcquisition,
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
  roomPrepared?: OpenCodePreparedRoomContinuation
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const lifetime: {
    closed: boolean;
    entered: boolean;
    retire?: () => void;
    acquisition?: NativeSessionAcquisition;
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
    roomPrepared?: OpenCodePreparedRoomContinuation;
  } = {
    closed: false,
    entered: false,
    acquisition,
    roomOrigin,
    roomPrepared,
    retire: roomPrepared
      ? () => {
          roomPrepared.nativeEntry.retired = true;
          roomPrepared.turn.controller.abort();
        }
      : undefined,
  };
  const stream = facet.sendOwnedMessage(sessionId, content, opts, lifetime);
  const close = () => {
    lifetime.closed = true;
    lifetime.retire?.();
    // Cancel the actual prepared native owner before generator return queues
    // behind a pending transport read. Its memo is joined below and in finally.
    if (roomPrepared) void roomPrepared.retire().catch(() => {});
  };
  const joinOriginalClose = async (result: ReturnType<typeof stream.return>) => {
    let failed = false;
    let first: unknown;
    let outcome: Awaited<ReturnType<typeof stream.return>> | undefined;
    try {
      outcome = await result;
    } catch (cause) {
      failed = true;
      first = cause;
    }
    const own = lifetime.roomPrepared!;
    try {
      retireOriginalCommittedRoomResponder(
        own.committed!,
        facet.runtime,
        own.prepared,
        own.nativeOperation
      );
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      await own.retire();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
    return outcome!;
  };
  const capturedReturn = stream.return.bind(stream);
  const returnOriginal: AsyncGenerator<StreamEvent>['return'] = (value) => {
    close();
    const result = capturedReturn(value);
    return roomPrepared ? joinOriginalClose(result) : result;
  };
  const returned: AsyncGenerator<StreamEvent> = {
    next: (value) => {
      if (!roomPrepared) return stream.next(value);
      return stream.next(value).then((result) => {
        const own = facet.custody.originalOpenCodeRoomStreams.get(returned)!;
        if (!result.done && result.value) {
          own.emitted.add(result.value);
          const data = result.value.data;
          if (
            data &&
            typeof data === 'object' &&
            'terminalReason' in data &&
            typeof data.terminalReason === 'string'
          )
            own.reason = data.terminalReason;
          if (
            result.value.type === 'error' &&
            !isNonFatalErrorCode(
              data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
                ? data.code
                : undefined
            )
          )
            own.failed = true;
          if (result.value.type === 'done') own.done = true;
        }
        return result;
      });
    },
    return: returnOriginal,
    [Symbol.asyncDispose]: async () => {
      await returnOriginal(undefined);
    },
    throw: (error) => {
      close();
      const result = stream.throw(error);
      return roomPrepared ? joinOriginalClose(result) : result;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  if (acquisition)
    facet.custody.originalOpenCodeLockedStreams.set(returned, {
      runtime: facet.runtime,
      sessionId,
      options: captureTurnLevelOptions(opts),
      current: () => {
        if (lifetime.closed) return false;
        const at = Date.now(),
          activity = captureNativeSessionActivity(acquisition, at);
        return !!activity && !!readNativeSessionAcquisition(acquisition, activity, at, sessionId);
      },
    });
  const originalReturn = returned.return.bind(returned);
  if (roomPrepared && roomPrepared.committed)
    facet.custody.originalOpenCodeRoomStreams.set(returned, {
      runtime: facet.runtime,
      prepared: roomPrepared.prepared,
      operation: roomPrepared.nativeOperation,
      committed: roomPrepared.committed,
      emitted: new WeakSet(),
      close: () => originalReturn(undefined),
      failed: false,
      done: false,
    });
  return returned;
}

/** Run the original guarded sendOwnedMessage operation. */
export async function* sendOwnedMessage(
  runtimeOwner: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  lifetime: {
    closed: boolean;
    entered: boolean;
    retire?: () => void;
    acquisition?: NativeSessionAcquisition;
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
    roomPrepared?: OpenCodePreparedRoomContinuation;
  }
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  let failed = false,
    first: unknown;
  const cleanup = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    const own = lifetime.roomPrepared;
    if (own) {
      if (failed || lifetime.closed)
        await cleanup(() =>
          retireOriginalCommittedRoomResponder(
            own.committed,
            facet.runtime,
            own.prepared,
            own.nativeOperation
          )
        );
      await cleanup(() => own.retire());
    }
    if (failed) throw first;
  };
  try {
    lifetime.entered = true;
    let settings = await facet.resolveTurnSettings(sessionId, opts);
    const cwd = opts?.cwd ?? facet.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
    // Who a room turn is for, which every identity decision below is checked
    // against (DOR-2091). Absent on every turn a room did not trigger.
    const forAgent = turnAgentOf(opts);
    // **Which model a credits turn runs** (DOR-2636), the same decision every
    // runtime on credits makes: once the service says which formats its models
    // are in, a model it does not serve in OpenCode's chat format runs on the
    // service's suggestion, said once and saved only once said, and a list
    // naming none refuses the turn. While the service says nothing, the
    // session's model stands and the sidecar's own fallback applies, as before.
    if (openCodeRunsOnCredits()) {
      let decided: CreditsModelDecision;
      try {
        decided = await decideCreditsLaunchModel({
          capabilities: facet.getCapabilities(),
          runtimeLabel: OPENCODE_LABEL,
          sessionId,
          model: creditsModelIdOf(settings.model),
          nameOf: async () =>
            settings.model === undefined
              ? undefined
              : catalogNameFor(facet.runtime, settings.model),
          remember: async (id) => {
            await facet.updateSession(sessionId, { model: creditsSelection(id) });
          },
        });
      } catch (err) {
        const refusal = creditsRefusalEvent(err);
        if (!refusal) throw err;
        const original = lifetime.roomPrepared;
        if (original) {
          // This claimed source did not start a model: retire its genuine
          // native authority before the refusal becomes observable. No retry.
          lifetime.closed = true;
          original.nativeEntry.retired = true;
          retireOriginalCommittedRoomResponder(
            original.committed,
            facet.runtime,
            original.prepared,
            original.nativeOperation
          );
        }
        yield refusal;
        return;
      }
      if (decided.model !== undefined && decided.model !== creditsModelIdOf(settings.model)) {
        settings = { ...settings, model: creditsSelection(decided.model) };
      }
      if (decided.swap?.notice) yield decided.swap.notice;
      await decided.swap?.commit();
    }
    facet.registry.recordMessage(sessionId, content, {
      cwd,
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
    });

    yield* facet.runOpenCodeTurn(
      sessionId,
      cwd,
      opts?.title,
      async (client, ocSessionId, dorkosApplied, connectionsApplied, plan) => {
        // Build the prompt only after the leased MCP reconcile, so the room
        // verbs describe what this exact turn can actually call.
        // The agent this turn acts as — anchored, so a room worktree reads as its
        // agent and a room turn as nobody but the agent it is for (DOR-2091).
        const agentPath = homeOf(resolveAgentHome(cwd, forAgent));
        const agentContext = await buildOpenCodeTurnContext(cwd, dorkosApplied, agentPath);
        // On credits the prompt always names the credits provider: the
        // session's model when it is a credits model, else the default one.
        const model =
          plan.mode === 'credits'
            ? creditsPromptModel(settings.model, plan)
            : parseModelSelection(settings.model);
        const agent = agentPath ? facet.meshCore?.getByPath(agentPath) : undefined;
        const accessContext =
          connectionsApplied && facet.connectorRuntimeTools && agent
            ? await facet.accountsAccess.select(facet.connectorRuntimeTools, agent.id, sessionId, {
                serviceCatalog: dorkosApplied,
              })
            : undefined;
        const turnOpts = accessContext
          ? {
              ...opts,
              additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
            }
          : opts;
        const system = buildOpenCodeSystem(turnOpts, agentContext);
        const sessionApi = client.session;
        const promptAsync = sessionApi.promptAsync;
        const promptInput = {
          path: { id: ocSessionId },
          body: {
            parts: buildOpenCodeParts(content, turnOpts),
            ...(system !== undefined ? { system } : {}),
            ...(model !== undefined ? { model } : {}),
          },
        };
        if (lifetime.roomPrepared) {
          const prepared = lifetime.roomPrepared;
          consumeOriginalCommittedRoomResponder(
            prepared.committed,
            facet.runtime,
            prepared.prepared,
            prepared.nativeOperation
          );
        }
        const prompted = await promptAsync.call(sessionApi, promptInput);
        const promptError = 'error' in prompted ? prompted.error : undefined;
        if (promptError === undefined) accessContext?.commit();
        if (promptError !== undefined) {
          throw new Error(`OpenCode session.promptAsync failed: ${JSON.stringify(promptError)}`);
        }
      },
      {
        connectorTurn: true,
        lifetime,
        ...(forAgent !== undefined ? { forAgent } : {}),
        grants: validatedGrants(opts?.additionalDirectories, cwd),
        ...(opts?.permissionCeiling !== undefined
          ? { permissionCeiling: opts.permissionCeiling }
          : {}),
      }
    );
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await drainOriginalCleanup();
  }
}
