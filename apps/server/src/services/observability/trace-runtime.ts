/**
 * Traces the AgentRuntime boundary in one place. {@link traceRuntime} wraps a
 * registered runtime so every `sendMessage` turn — from any caller (interactive
 * trigger, task scheduler, embedded, UI action) — gets a `runtime.send_message`
 * span with the runtime type and the turn's event count. This is the single
 * seam for runtime-call spans: no span code is scattered into the runtime
 * adapters themselves.
 *
 * When tracing is off the runtime is returned untouched (zero overhead); when
 * on, a thin Proxy intercepts only `sendMessage` and passes every other member
 * straight through, bound to the real runtime so private state stays intact.
 *
 * @module services/observability/trace-runtime
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { isTracingEnabled, tracedGenerator } from './otel.js';
import { SPAN, ATTR } from './attributes.js';

/**
 * Wrap a runtime so its `sendMessage` turns are traced. Returns the runtime
 * unchanged when debug tracing is disabled.
 *
 * @param runtime - The runtime to instrument.
 * @returns The same runtime (off) or a tracing proxy over it (on).
 */
export function traceRuntime(runtime: AgentRuntime): AgentRuntime {
  if (!isTracingEnabled()) return runtime;

  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> =>
          tracedGenerator(
            SPAN.RUNTIME_SEND_MESSAGE,
            { [ATTR.RUNTIME]: target.type, [ATTR.SESSION_ID]: sessionId },
            target.sendMessage(sessionId, content, opts)
          );
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
