import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse, LiveSessionRef } from '@dorkos/shared/agent-runtime';
import { picksSession } from '@dorkos/shared/agent-runtime';
import type { NativeSessionAcquisition } from '../../../session/session-lock.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
} from '../../../session/session-lock.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import {
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/operations/room-current-operation.js';
import { readOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import { readCodexNativeOperation } from '../codex-runtime.js';
import {
  wakeContextOf,
  type CodexPreparedRoomContinuation,
  type CodexWakeContext,
} from './codex-runtime-data.js';
import { logger } from '../../../../lib/logger.js';
import { turnAgentOf, resolveAgentTokenEnv } from '../../../core/agent-identity/index.js';
import {
  catalogNameFor,
  decideCreditsLaunchModel,
  type CreditsModelDecision,
} from '../../../core/cloud/credits-models.js';
import {
  creditsRefusalEvent,
  asCreditsStopped,
  type CreditsLaunch,
} from '../../../core/cloud/credits-protocols.js';
import {
  connectorRuntimeHeaders,
  type ConnectorRuntimeMcpInjection,
} from '../../connector-tools.js';
import type {
  OpenConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../../connectors/runtime-principal-port.js';
import { type ConnectorTurnLeaseSupervisorHandle } from '../../connectors/connector-turn-lease-supervisor.js';
import { openTurnOrSkip, startConnectorLease } from '../../connectors/open-connector-turn.js';
import { resolveDorkosMcpInjection } from '../../shared/dorkos-mcp-injection.js';
import { resolveManagedMcpServers } from '../mcp-server-config.js';
import { grantedWritableDirectories, buildCodexPrompt } from '../turn-input.js';
import { buildAgentContextAppend } from '../../shared/agent-context.js';
import { buildRoomToolsBlock } from '../../shared/room-tools-context.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../../shared/dorkos-tool-names.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../../shared/permission-tool-filter.js';
import { createCodexEventContext } from '../event-mapper.js';
import { readCodexTurnReading } from '../turn-context-usage.js';
import { creditsCodexHome } from '../codex-home.js';
import { captureCodexMedia } from '../media-capture.js';
import type { OriginalCodexOwnedMessageView } from './codex-owned-message-context.js';

/** External factories have unrelated keys; the actual producer registrar stays runtime-module private. */
export function createIsolatedCodexOwnedMessageProducer() {
  const views = new WeakMap<object, OriginalCodexOwnedMessageView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): OriginalCodexOwnedMessageView {
    const view = apply(get, views, [owner]) as OriginalCodexOwnedMessageView | undefined;
    if (!view) throw new Error('Unknown original Codex owned message producer.');
    return view;
  }
  async function* sendOriginalOwnedMessage(
    owner: object,
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: CodexPreparedRoomContinuation;
    },
    origin: 'dispatched' | 'runtime',
    inherited?: CodexWakeContext
  ): AsyncGenerator<StreamEvent> {
    const facet = actual(owner);
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
      if (origin === 'dispatched') {
        for (const listener of facet.dispatchedTurnListeners) {
          try {
            listener(sessionId);
          } catch (err) {
            logger.warn('[CodexRuntime] dispatched-turn listener threw', { err });
          }
        }
        facet.consecutiveWakes.delete(sessionId);
      }
      // Seed from the durable row before any registry mutation: recordMessage's
      // title-if-blank derivation must see the persisted title, not a fresh
      // blank entry it would fill with an auto-preview (see seedFromDurable).
      const importCurrent = () => {
        if (lifetime.closed) return false;
        if (
          lifetime.roomOrigin &&
          readOriginalRoomDispatchLifecycle(lifetime.roomOrigin.holder, facet.runtime) !==
            lifetime.roomOrigin.custody
        )
          return false;
        if (lifetime.acquisition) {
          const at = Date.now(),
            activity = captureNativeSessionActivity(lifetime.acquisition, at);
          if (
            !activity ||
            !readNativeSessionAcquisition(lifetime.acquisition, activity, at, sessionId)
          )
            return false;
        }
        return (
          !lifetime.roomPrepared ||
          readCodexNativeOperation(lifetime.roomPrepared.nativeOperation) !== undefined
        );
      };
      if (!importCurrent()) return;
      await facet.importNativeThread(sessionId, importCurrent);
      if (!importCurrent()) return;
      await facet.seedFromDurable(sessionId);
      let settings = await facet.resolveTurnSettings(sessionId, opts);
      const binding = facet.threadMap.get(sessionId);
      const boundThreadId = binding?.threadId;
      // Resolution order (post-restart safe): per-send override → in-memory
      // registry → the persisted binding's cwd → the server's default root. The
      // registry is empty after a restart, so the persisted cwd is what keeps
      // `codex exec` in the right dir. The default-root floor guarantees the
      // turn, the registry entry, and the binding row persisted below always
      // carry a real cwd — a cwd-less session belongs to no project list and
      // would be invisible in every sidebar (DOR-202).
      const cwd =
        opts?.cwd ?? facet.registry.get(sessionId)?.cwd ?? binding?.cwd ?? facet.defaultCwd;
      // Durably backfill a legacy cwd-less binding row (NULL-guarded, so the
      // first-write-wins binding is never overwritten). Without this the session
      // gains a cwd in memory only and re-hydrates cwd-less — invisible in every
      // list — after each restart. Best-effort like persistSessionMetadata.
      if (binding !== undefined && binding.cwd === undefined) {
        try {
          facet.threadMap.backfillCwd(sessionId, cwd);
        } catch (err) {
          logger.warn('[CodexRuntime] failed to backfill binding cwd', { sessionId, err });
        }
      }
      if (origin === 'dispatched') {
        facet.registry.recordMessage(sessionId, content, {
          cwd,
          ...(opts?.title !== undefined ? { title: opts.title } : {}),
        });
        // Write the refreshed preview/updatedAt (and first-turn title) through to
        // the durable row. A no-op before the first bind — the setThreadId below
        // carries the first turn's metadata with the row instead.
        facet.persistSessionMetadata(sessionId);
      }

      // Which registered agent does this turn act as? Everything below that
      // mints, injects or names a tool is gated on the answer, and the agent's
      // context is read from it. Resolved to a home rather than read off `cwd`
      // (DOR-2091, DOR-2355): a turn may stand in a room worktree, a worktree of
      // the agent's own repo or a managed checkout, none of which is the home —
      // and it is nobody when the turn names a different agent. `cwd` stays where
      // the thread runs; `agentPath` is whose identity it has.
      const agentPath = facet.identityPathFor(cwd, turnAgentOf(opts));
      const meshAgent = agentPath ? facet.meshCore?.getByPath(agentPath) : undefined;

      // **Who pays** (ADR 261001-000811), decided before anything starts. A
      // thread that already exists stays on whatever paid for it: its rollout
      // lives in exactly one Codex home. A new thread runs on DorkOS credits
      // when that is Codex's recorded default. A credits turn with no live token
      // is REFUSED here, and nothing is spawned.
      let credits: CreditsLaunch | null;
      let creditsSwap: CreditsModelDecision['swap'];
      try {
        credits = await facet.creditsLaunchFor(boundThreadId);
        // **Which model a credits turn runs** (DOR-2636), the same decision every
        // runtime on credits makes: once the service says which formats its
        // models are in, a model it does not serve in Codex's format runs on the
        // service's suggestion instead, and a list naming none refuses the turn.
        // While the service says nothing, the session's model stands.
        if (credits) {
          const decided = await decideCreditsLaunchModel({
            capabilities: facet.getCapabilities(),
            runtimeLabel: 'Codex',
            sessionId,
            model: settings.model,
            nameOf: async () =>
              settings.model === undefined
                ? undefined
                : catalogNameFor(facet.runtime, settings.model),
            remember: async (model) => {
              await facet.updateSession(sessionId, { model });
            },
          });
          if (decided.model !== undefined) settings = { ...settings, model: decided.model };
          creditsSwap = decided.swap;
        }
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
      // Said before anything is spawned, and saved only once it has been said: a
      // swap's notice and its save are one step (`CreditsModelDecision.swap`).
      if (creditsSwap?.notice) yield creditsSwap.notice;
      await creditsSwap?.commit();

      if (lifetime.closed) return;
      const controller = lifetime.roomPrepared?.controller ?? new AbortController();
      const { nativeOperation, nativeEntry } =
        lifetime.roomPrepared ??
        facet.installNativeTurn(
          sessionId,
          cwd,
          agentPath,
          controller,
          lifetime.acquisition,
          false,
          lifetime.roomOrigin
        );
      lifetime.retire = () => {
        nativeEntry.retired = true;
      };

      if (credits) facet.creditsTurns.add(controller);
      let connectorBinding: OpenConnectorTurnResult | undefined;
      let connectorSupervisor: ConnectorTurnLeaseSupervisorHandle | undefined;
      let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
      let connectorRuntimeFailed = false;
      try {
        let connectorTools: ConnectorRuntimeMcpInjection | null = null;
        if (facet.connectorRuntimeTools && meshAgent && agentPath) {
          connectorBinding =
            lifetime.roomPrepared?.binding ??
            (await openTurnOrSkip(
              facet.connectorRuntimeTools.principals,
              {
                runtime: facet.type,
                canonicalSessionId: sessionId,
                agentPath,
                canonicalCwd: cwd,
                signal: controller.signal,
              },
              { isCurrent: () => facet.activeTurns.get(sessionId) === controller, nativeOperation }
            )) ??
            undefined;
          if (connectorBinding) {
            facet.activeConnectorBindings.set(controller, connectorBinding.bindingId);
            connectorSupervisor = startConnectorLease(
              facet.connectorRuntimeTools,
              connectorBinding,
              {
                runtime: facet.type,
                signal: controller.signal,
                onLost: (loss) => logger.warn('[CodexRuntime] Connections lease lost', loss),
              }
            );
            connectorTools = {
              url: facet.connectorRuntimeTools.listenerUrl,
              agentToolsUrl: facet.connectorRuntimeTools.agentToolsUrl,
              headers: connectorRuntimeHeaders({
                bearer: connectorBinding.bearer,
                runtime: facet.type,
                canonicalCwd: cwd,
              }),
            };
          }
        }

        // Mint this session's agent identity token when this cwd hosts a registered
        // agent. It rides the subprocess env, never the prompt, so it stays a
        // credential for the `dorkos` commands the agent runs rather than text in its
        // context and transcript (spec `agent-trust` §3.1). `{}` leaves the turn
        // unattributed, exactly as before.
        //
        // Minted under the name a PERSON reads, never the slug: the token's label
        // is replayed onto the agent's author row by every room tool it calls, so
        // the slug there renames a live agent mid-conversation (DOR-1264).
        const mintAgentToken = () =>
          resolveAgentTokenEnv(
            meshAgent ? agentPath : undefined,
            meshAgent?.displayName ?? meshAgent?.name
          );
        const mintsOnLoad = facet.transport.kind === 'app-server' && meshAgent !== undefined;
        const agentTokenEnv = mintsOnLoad ? {} : await mintAgentToken();

        // The `dorkos` tool server, when the experiment is on and this cwd hosts a
        // registered agent (spec `tool-only-room-replies` §D4). It reuses the
        // already-open connector turn binding on a separate capability route, so
        // it expires and revokes with this exact turn. `null` injects nothing.
        //
        // Scoped to every agent-bound session rather than to room turns: the runtime
        // cannot know why it was called, and these tools are worth having outside a
        // room anyway.
        //
        // Resolved BEFORE the managed servers because it decides whether the name
        // `dorkos` is reserved against them this turn — see below.
        const dorkosTools = await resolveDorkosMcpInjection(
          meshAgent ? agentPath : undefined,
          connectorTools
        );

        // The agent's ENABLED managed MCP servers, injected inline via
        // `config.mcp_servers` (spec `mcp-server-management` §6, DOR-892). Keyed
        // on the agent the turn acts as — its own folder even when it stands in a
        // room worktree (DOR-2091) — and a non-agent session contributes none.
        // No anchored agent — including a refused turn standing in another
        // agent's folder — means no managed servers, never the directory's.
        const managedMcpServers = agentPath
          ? resolveManagedMcpServers(facet.managedMcpServers, agentPath, dorkosTools !== null)
          : { servers: {}, env: {} };

        const writableDirectories = grantedWritableDirectories(opts?.additionalDirectories, cwd);
        const binary = await facet.resolveTurnBinary();
        if (boundThreadId === undefined) facet.contextGate.forget(sessionId);

        // Runtime-neutral DorkOS context (identity, persona, safety boundaries,
        // <dorkos_context>, <env>): the same blocks the Claude adapter injects, so a
        // Codex agent knows who it is and how to reach its capabilities.
        //
        // Codex's only input channel is the prompt, and a prompt lands in the
        // thread's persisted rollout, so re-sending this every turn leaves one copy
        // per turn IN the conversation. {@link CodexContextGate} decides which half
        // this turn owes: the whole append when the thread has not been told (or the
        // agent was edited since), the memory block alone otherwise — memory is
        // outside the gate because it changes while the thread runs.
        const neutralContextSelection = facet.contextGate.select(
          sessionId,
          await buildAgentContextAppend(agentPath, cwd)
        );

        // The room verbs, and ONLY when this turn actually carries them — gated on
        // the resolved injection itself, not on a second guess at it, so the prose
        // and the wiring cannot disagree (spec `tool-only-room-replies` §D11).
        // Named under codex's own MCP prefix, never claude-code's: a bare or
        // wrongly-prefixed name is uncallable, which is the DOR-1292 defect.
        //
        // Outside the context gate, and deliberately: whether this session HAS the
        // room tools is answered per turn, so a menu written in the wrong tense must
        // never survive into a turn where it is false.
        //
        // Beside it, one line per Blocked permission area (spec `agent-permissions`
        // D15), resolved per turn like the menu: the runtime listener hides the
        // same area's tools from this turn's list.
        const agentContext = dorkosTools
          ? [
              neutralContextSelection.text,
              buildRoomToolsBlock(CODEX_DORKOS_TOOL_PREFIX),
              // The agent's own Blocked areas, read where its manifest lives —
              // the listener hides the same areas keyed on the same anchor.
              renderBlockedAreaLines((await resolveToolVisibilityFor(agentPath)).blockedAreas),
            ]
              .filter(Boolean)
              .join('\n\n')
          : neutralContextSelection.text;

        const accessContext =
          connectorTools && facet.connectorRuntimeTools && meshAgent
            ? await facet.accountsAccess.select(
                facet.connectorRuntimeTools,
                meshAgent.id,
                sessionId,
                {
                  serviceCatalog: Boolean(dorkosTools),
                }
              )
            : undefined;
        const turnOpts = accessContext
          ? {
              ...opts,
              additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
            }
          : opts;
        // No room marker: `control_ui` is a `ui` capability now, and its handler
        // reads the room this turn is answering in from the runtime-neutral turn
        // facts the trigger bound (spec `canvas-agent-seat` §5). The mapper has
        // nothing left to refuse.
        // A credits thread's rollout is in the credits home. Its context reading
        // is read from there, and its rate limits are dropped: they are the
        // credits endpoint's, not the person's Codex account's, and must never
        // be filed under that account's usage.
        const ctx = createCodexEventContext(
          sessionId,
          credits
            ? {
                readTurnContextUsage: async (threadId, turnStartedAtMs, signal) => {
                  const reading = await readCodexTurnReading({
                    threadId,
                    turnStartedAtMs,
                    signal,
                    codexHome: creditsCodexHome(),
                  });
                  return reading ? { ...reading, rateLimits: [] } : null;
                },
              }
            : {}
        );
        connectorRevokeReason = 'runtime_failed';
        if (lifetime.roomPrepared) {
          const prepared = lifetime.roomPrepared;
          consumeOriginalCommittedRoomResponder(
            prepared.committed,
            facet.runtime,
            prepared.prepared,
            nativeOperation
          );
        }
        const turnEvents = facet.runTransportTurn.call(facet.transport, {
          binary,
          sessionId,
          boundThreadId,
          cwd,
          settings,
          writableDirectories,
          prompt: buildCodexPrompt(content, turnOpts, agentContext),
          // What a wake from this turn's leftover work runs with: the same
          // agent, folder, grants and settings. A wake's own turn passes its
          // context on, so a chain of wakes stays the same agent.
          ...(() => {
            const wakeContext = inherited ?? wakeContextOf(opts, cwd);
            return wakeContext ? { wakeContext } : {};
          })(),
          ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
          launch: credits ? { home: 'credits', credits } : { home: 'person' },
          tools: {
            agentTokenEnv,
            ...(mintsOnLoad ? { mintAgentToken } : {}),
            managed: managedMcpServers,
            dorkosTools,
            connectorTools,
            ...(connectorBinding ? { connectorBindingId: connectorBinding.bindingId } : {}),
          },
          signal: controller.signal,
          events: ctx,
          // Persisted the moment the transport learns the id — before the
          // terminal done — so even an interrupted or crashed first turn stays
          // resumable. The cwd is persisted with it so a post-restart resume runs
          // in the right dir, and the registry's current display metadata rides
          // along so the first turn's title/preview land with the row.
          // First-write-wins keeps re-binds benign; `replaces` is the one
          // exception (a thread Codex can no longer continue, spec §6).
          onThreadBound: (threadId, replaces) => {
            if (replaces !== undefined) {
              facet.threadMap.replaceThreadId(sessionId, replaces, threadId);
              return;
            }
            const tracked = facet.registry.get(sessionId);
            facet.threadMap.setThreadId(
              sessionId,
              threadId,
              cwd,
              tracked ? facet.toMetadataPatch(tracked) : undefined
            );
          },
        });
        let completedTurn = false;
        let sawDone = false;
        let sawCompaction = false;
        for await (const event of turnEvents) {
          if (event.type === 'done') sawDone = true;
          if (event.type === 'compact_boundary') sawCompaction = true;
          if (
            event.type === 'session_status' &&
            'terminalReason' in event.data &&
            event.data.terminalReason === 'completed'
          )
            completedTurn = true;
          // On credits, a refused token is the credits card, never a Codex
          // sign-in error: the person's own sign-in was not used.
          yield credits ? asCreditsStopped(event, 'Codex') : event;
          if (
            event.type === 'session_status' &&
            'terminalReason' in event.data &&
            event.data.terminalReason === 'error'
          ) {
            connectorRuntimeFailed = true;
          }
          // The async half of media mapping. `mapCodexThread` is pure and cannot
          // store bytes, so it records what it saw on `ctx` and this drains it
          // here — after the event it rode in on, so an image lands in the
          // transcript exactly where the tool result that produced it did.
          yield* captureCodexMedia(facet.attachments, sessionId, ctx);
        }
        if (!sawDone) {
          logger.error('[CodexRuntime] a turn ended without its done; closing it', { sessionId });
          yield { type: 'done', data: { sessionId } };
        }
        // Successful consumption, not creation of a lazy transport iterator, is delivery.
        // Only acknowledge after successful consumption; failures keep the notice owed.
        if (completedTurn && !connectorRuntimeFailed && !controller.signal.aborted) {
          neutralContextSelection.commit();
          accessContext?.commit();
        }
        // A mid-turn summary may discard identity context; re-anchor the next turn.
        if (sawCompaction) facet.contextGate.forget(sessionId);
        connectorRevokeReason = connectorRuntimeFailed ? 'runtime_failed' : 'turn_terminal';
      } catch (cause) {
        failed = true;
        first = cause;
      } finally {
        nativeEntry.retired = true;
        if (controller.signal.aborted) connectorRevokeReason = 'turn_cancelled';
        await cleanup(() => connectorSupervisor?.stop());
        if (!lifetime.roomPrepared)
          await cleanup(async () => {
            if (connectorBinding && facet.activeConnectorBindings.has(controller)) {
              facet.activeConnectorBindings.delete(controller);
              await facet.connectorRuntimeTools?.principals.revoke(
                connectorBinding.bindingId,
                connectorRevokeReason
              );
            }
          });
        facet.creditsTurns.delete(controller);
        if (facet.activeTurns.get(sessionId) === controller) facet.activeTurns.delete(sessionId);
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    } finally {
      await drainOriginalCleanup();
    }
  }
  async function endOriginalOwnedSessionsWhere(
    owner: object,
    belongs: (session: LiveSessionRef) => boolean
  ): Promise<string[]> {
    const facet = actual(owner);
    const ids = new Set([
      ...facet.activeTurns.keys(),
      ...(facet.transport.liveSessionIds?.() ?? []),
    ]);
    const ended: string[] = [];
    for (const sessionId of ids) {
      const cwd = facet.registry.get(sessionId)?.cwd ?? facet.threadMap.get(sessionId)?.cwd;
      if (!picksSession(belongs, { sessionId, cwd })) continue;
      const receipt = await facet.runtime.interruptQuery(sessionId).catch(() => undefined);
      const released = await (
        facet.transport.endSession?.(sessionId) ?? Promise.resolve(false)
      ).catch(() => false);
      if (receipt?.outcome === 'acked' || receipt?.outcome === 'closed' || released) {
        ended.push(sessionId);
      }
    }
    return ended;
  }
  return Object.freeze({
    register(owner: object, view: OriginalCodexOwnedMessageView): void {
      apply(set, views, [owner, view]);
    },
    sendOriginalOwnedMessage,
    endOriginalOwnedSessionsWhere,
  });
}
