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
import type { UiState } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { getOrCreateProjector, rekeyProjector } from './session-state-projector.js';
import { triggerTurn } from './trigger-turn.js';
import type { TriggerTurnResult } from './trigger-turn.js';

/** Inputs for a single embedded turn trigger. */
export interface EmbeddedTriggerOpts {
  sessionId: string;
  /** Lock identity of the embedding client (e.g. the DirectTransport's clientId). */
  clientId: string;
  content: string;
  cwd?: string;
  uiState?: UiState;
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
    async trigger({ sessionId, clientId, content, cwd, uiState }) {
      // Mirror the HTTP route: the caller-chosen cwd is authoritative —
      // overwrite any earlier first-writer-wins stamp from a subscribe-path
      // default so liveness aggregates under the correct project.
      const projector = getOrCreateProjector(sessionId, cwd);
      if (cwd !== undefined) projector.cwd = cwd;

      return triggerTurn({
        sessionId,
        clientId,
        content,
        cwd,
        uiState,
        projector,
        deps: {
          acquireLock: (sid, cid, lifecycle, token) =>
            runtime.acquireLock(sid, cid, lifecycle, token),
          releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
          sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
          getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
          rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
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
