/**
 * Traces the AgentRuntime boundary in one place. {@link traceRuntime} wraps a
 * registered runtime so every `sendMessage` turn — from any caller (interactive
 * trigger, task scheduler, embedded, UI action) — is observed at one seam: no
 * span code is scattered into the runtime adapters themselves.
 *
 * The wrap drives BOTH AI-observability outputs (ADR 260713-143958 Phase 7) via
 * {@link observeRuntimeTurn}: when tracing is on it enriches the
 * `runtime.send_message` span with the runtime type, the turn's event count, and
 * the turn's `gen_ai.*` metadata; when the opt-in `telemetry.aiMetadata` bridge
 * is installed it emits a per-turn `$ai_generation` event. Both read only
 * non-content metadata off the turn's status events.
 *
 * When neither output is active the runtime is returned untouched (zero
 * overhead); otherwise a thin Proxy intercepts only `sendMessage` and passes
 * every other member straight through, bound to the real runtime so private
 * state stays intact.
 *
 * @module services/observability/trace-runtime
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { isAiObservabilityActive, observeRuntimeTurn } from './ai-metadata.js';

/**
 * Wrap a runtime so its `sendMessage` turns are observed. Returns the runtime
 * unchanged when neither tracing nor the AI-metadata bridge is active.
 *
 * @param runtime - The runtime to instrument.
 * @returns The same runtime (off) or an observing proxy over it (on).
 */
export function traceRuntime(runtime: AgentRuntime): AgentRuntime {
  if (!isAiObservabilityActive()) return runtime;

  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> =>
          observeRuntimeTurn(target.type, sessionId, target.sendMessage(sessionId, content, opts));
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
