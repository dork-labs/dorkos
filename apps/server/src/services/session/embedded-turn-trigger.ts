/**
 * Embedded (in-process) turn trigger for `DirectTransport` hosts.
 *
 * The Obsidian plugin embeds the runtime directly — there is no Express layer,
 * so `DirectTransport.postMessage` cannot reach `POST /api/sessions/:id/messages`.
 * This factory packages the SAME orchestration that route performs ({@link
 * triggerTurn} + projector registry) into a single in-process bridge the plugin
 * wires into `DirectTransportServices.turnTrigger`, so embedded sends follow the
 * identical trigger-only contract (ADR-0264): the turn runs detached, feeding
 * the per-session projector, and delivery happens solely over the runtime's
 * `subscribeSession` stream.
 *
 * @module services/session/embedded-turn-trigger
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { logger } from '../../lib/logger.js';
import { getOrCreateProjector, rekeyProjector } from './session-state-projector.js';
import { triggerTurn } from './trigger-turn.js';
import type { TriggerTurnResult } from './trigger-turn.js';
import { triggerCommandIntent } from './trigger-command-intent.js';
import type { TriggerCommandIntentResult } from './trigger-command-intent.js';

/** Inputs for a single embedded turn trigger. */
export interface EmbeddedTriggerOpts {
  sessionId: string;
  /** Lock identity of the embedding client (e.g. the DirectTransport's clientId). */
  clientId: string;
  content: string;
  cwd?: string;
  /** Neutral client-sourced context signals (ui_state, queued) for this turn. */
  context?: ClientContext;
}

/** The in-process trigger bridge `DirectTransport.postMessage` calls. */
export interface EmbeddedTurnTrigger {
  /** Trigger a detached turn; resolves with the lock outcome and canonical id. */
  trigger(opts: EmbeddedTriggerOpts): Promise<TriggerTurnResult>;
}

/**
 * Build an {@link EmbeddedTurnTrigger} bound to one runtime instance.
 *
 * @param runtime - The embedded runtime (lock owner, message generator, id resolver).
 */
export function createEmbeddedTurnTrigger(runtime: AgentRuntime): EmbeddedTurnTrigger {
  return {
    async trigger({ sessionId, clientId, content, cwd, context }) {
      // Mirror the HTTP route: the caller-chosen cwd is authoritative —
      // overwrite any earlier first-writer-wins stamp from a subscribe-path
      // default so liveness aggregates under the correct project.
      // Persist completed turns for LOG-BACKED runtimes (DOR-189), mirroring
      // the HTTP route; claude-code opts out.
      const projector = getOrCreateProjector(sessionId, cwd, {
        persist: runtime.getCapabilities().logBackedHistory === true,
      });
      if (cwd !== undefined) projector.cwd = cwd;

      return triggerTurn({
        sessionId,
        clientId,
        content,
        cwd,
        context,
        projector,
        deps: {
          acquireLock: (sid, cid, lifecycle, token) =>
            runtime.acquireLock(sid, cid, lifecycle, token),
          releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
          sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
          interruptQuery: (sid) => runtime.interruptQuery(sid),
          getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
          rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
          getCapabilities: () => runtime.getCapabilities(),
        },
        onError: (err) => {
          logger.warn('[EmbeddedTurnTrigger] detached turn error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });
    },
  };
}

/** Inputs for a single embedded command-intent trigger. */
export interface EmbeddedCommandIntentOpts {
  sessionId: string;
  /** Lock identity of the embedding client (e.g. the DirectTransport's clientId). */
  clientId: string;
  /** The runtime-fulfilled intent to dispatch (e.g. `'compact'`). */
  intent: RuntimeCommandIntentId;
  cwd?: string;
}

/** The in-process trigger bridge `DirectTransport.runCommandIntent` calls. */
export interface EmbeddedCommandIntentTrigger {
  /** Trigger a detached command-intent run; resolves the lock outcome. */
  trigger(opts: EmbeddedCommandIntentOpts): TriggerCommandIntentResult;
}

/**
 * Build an {@link EmbeddedCommandIntentTrigger} bound to one runtime instance —
 * the command-intent twin of {@link createEmbeddedTurnTrigger}, so an embedded
 * `runCommandIntent` follows the identical trigger-only contract (ADR-0264): the
 * run feeds the per-session projector and delivery flows over `subscribeSession`.
 * The caller (the client) pre-gates on the runtime's
 * `capabilities.commandIntents[intent].supported`, so this is reached only for a
 * supported intent.
 *
 * @param runtime - The embedded runtime (lock owner, intent generator).
 */
export function createEmbeddedCommandIntentTrigger(
  runtime: AgentRuntime
): EmbeddedCommandIntentTrigger {
  return {
    trigger({ sessionId, clientId, intent, cwd }) {
      // Persist completed runs for LOG-BACKED runtimes (DOR-189), mirroring the
      // turn trigger; claude-code opts out.
      const projector = getOrCreateProjector(sessionId, cwd, {
        persist: runtime.getCapabilities().logBackedHistory === true,
      });
      if (cwd !== undefined) projector.cwd = cwd;

      return triggerCommandIntent({
        sessionId,
        clientId,
        intent,
        cwd,
        projector,
        deps: {
          acquireLock: (sid, cid, lifecycle, token) =>
            runtime.acquireLock(sid, cid, lifecycle, token),
          releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
          executeCommandIntent: (sid, i, o) => runtime.executeCommandIntent(sid, i, o),
          interruptQuery: (sid) => runtime.interruptQuery(sid),
        },
        onError: (err) => {
          logger.warn('[EmbeddedCommandIntentTrigger] detached run error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });
    },
  };
}
