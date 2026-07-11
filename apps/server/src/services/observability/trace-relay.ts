/**
 * Traces relay dispatch in one place. {@link traceRelay} wraps the server's
 * {@link RelayCore} so every `publish` gets a `relay.dispatch` span carrying a
 * coarse subject bucket and the delivered-endpoint count — never the raw
 * subject (which can name agents) or the payload.
 *
 * When tracing is off the relay is returned untouched (zero overhead); when on,
 * a thin Proxy intercepts only `publish` and passes every other member through,
 * bound to the real relay so its private state stays intact.
 *
 * @module services/observability/trace-relay
 */
import type { RelayCore, PublishOptions, PublishResult } from '@dorkos/relay';
import { isTracingEnabled, withSpan } from './otel.js';
import { SPAN, ATTR } from './attributes.js';

/**
 * Bucket a relay subject into a coarse, non-identifying kind. System subjects
 * (`relay.system.*`, e.g. task dispatch) are `'system'`; everything else is
 * `'agent'`. The raw subject is never recorded.
 *
 * @param subject - The relay subject being published to.
 */
function subjectKind(subject: string): 'system' | 'agent' {
  return subject.startsWith('relay.system') ? 'system' : 'agent';
}

/**
 * Wrap a relay core so its `publish` dispatches are traced. Returns the relay
 * unchanged when debug tracing is disabled.
 *
 * @param relay - The relay core to instrument.
 * @returns The same relay (off) or a tracing proxy over it (on).
 */
export function traceRelay(relay: RelayCore): RelayCore {
  if (!isTracingEnabled()) return relay;

  return new Proxy(relay, {
    get(target, prop) {
      if (prop === 'publish') {
        return (
          subject: string,
          payload: unknown,
          options: PublishOptions
        ): Promise<PublishResult> =>
          withSpan(
            SPAN.RELAY_DISPATCH,
            { [ATTR.SUBJECT_KIND]: subjectKind(subject) },
            async (span) => {
              const result = await target.publish(subject, payload, options);
              span.setAttr(ATTR.DELIVERED_TO, result.deliveredTo);
              return result;
            }
          );
      }
      // Receiver is the real target so private-field access in getters/methods
      // resolves against the owning instance.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
