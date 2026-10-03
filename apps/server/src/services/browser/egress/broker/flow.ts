import type { OwnedSocket, RequestBody } from './transport.js';
import { BrokerError } from './errors.js';
/** Capture methods before final buffer/close/authority observations and invocation. */
export function guardedWrite(
  target: OwnedSocket,
  bytes: Uint8Array,
  check: () => void,
  limit: number
) {
  const length = bytes.byteLength,
    write = target.write,
    buffered = target.writableBytes,
    closed = target.observedClosed;
  check();
  if (closed) throw new BrokerError('CLOSED');
  if (length + buffered > limit) throw new BrokerError('BYTE_LIMIT');
  return Reflect.apply(write, target, [bytes]) as boolean;
}
/** Cleanup pauses are separate; ordinary operations require current, open targets. */
export function guardedCall(
  target: RequestBody | OwnedSocket,
  operation: 'pause' | 'resume' | 'end',
  check: () => void
) {
  const call = (target as OwnedSocket)[operation],
    closed = (target as Partial<OwnedSocket>).observedClosed;
  check();
  if (closed) throw new BrokerError('CLOSED');
  Reflect.apply(call, target, []);
}
/** One bounded direction owns its accepted queue and optional ordinary-response EOF. */
export function forwardFlow(options: {
  source: RequestBody | OwnedSocket;
  target: OwnedSocket;
  check: () => void;
  limit: number;
  queueLimit: number;
  onFailure: (cause: BrokerError) => void;
  onBytes?: (n: number) => void;
  initiallyBlocked?: boolean;
  endOnSourceEOF?: boolean;
  resumeOnStart?: boolean;
}) {
  let total = 0;
  let queued = 0;
  let blocked = options.initiallyBlocked ?? false;
  let stopped = false;
  let ended = false;
  let endStarted = false;
  let writing = false;
  const pending: Uint8Array[] = [];
  const detachments: (() => void)[] = [];
  const check = () => {
    options.check();
    if (stopped) throw new BrokerError('CLOSED');
  };
  const stop = () => {
    stopped = true;
    pending.length = 0;
    queued = 0;
    for (const detach of detachments.splice(0)) {
      try {
        detach();
      } catch {
        // Admission is already closed; attempt every remaining owned detachment.
      }
    }
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    try {
      options.source.pause();
    } catch {
      // A failed cleanup request cannot suppress terminal owner notification.
    }
    options.onFailure(error instanceof BrokerError ? error : new BrokerError('UNAVAILABLE'));
  };
  const complete = () => {
    if (!ended || stopped || writing || blocked || pending.length || endStarted) return;
    endStarted = true;
    guardedCall(options.target, 'end', check);
  };
  const resume = () => {
    if (stopped || ended || blocked || writing) return;
    const call = options.source.resume,
      closed = (options.source as Partial<OwnedSocket>).observedClosed;
    check();
    // Capture and authority callbacks can deliver EOF before the unstarted resume.
    if (ended || blocked || writing) return;
    if (closed) throw new BrokerError('CLOSED');
    Reflect.apply(call, options.source, []);
  };
  const write = (bytes: Uint8Array) => {
    writing = true;
    try {
      check();
      options.onBytes?.(bytes.byteLength);
      blocked = !guardedWrite(options.target, bytes, check, options.queueLimit);
    } finally {
      writing = false;
    }
    if (blocked) guardedCall(options.source, 'pause', check);
  };
  const drainPending = () => {
    while (pending.length && !blocked && !stopped) {
      const bytes = pending.shift()!;
      queued -= bytes.byteLength;
      write(bytes);
    }
  };
  const register = (acquire: () => () => void) => {
    const detach = acquire();
    if (stopped) {
      try {
        detach();
      } catch {
        // A synchronous callback may stop the flow before registration returns.
      }
    } else detachments.push(detach);
  };
  try {
    if (blocked) guardedCall(options.source, 'pause', check);
    const onData = options.source.onData;
    check();
    register(
      () =>
        Reflect.apply(onData, options.source, [
          (bytes: Uint8Array) => {
            try {
              if (stopped) return;
              check();
              if (ended) throw new BrokerError('FRAMING_REFUSED');
              total += bytes.byteLength;
              if (total > options.limit) throw new BrokerError('BYTE_LIMIT');
              if (blocked || writing) {
                queued += bytes.byteLength;
                if (queued + options.target.writableBytes > options.queueLimit)
                  throw new BrokerError('BYTE_LIMIT');
                const owned = Uint8Array.from(bytes);
                check();
                pending.push(owned);
                return;
              }
              write(bytes);
              drainPending();
              complete();
            } catch (error) {
              fail(error);
            }
          },
        ]) as () => void
    );
    const onDrain = options.target.onDrain;
    check();
    register(
      () =>
        Reflect.apply(onDrain, options.target, [
          () => {
            try {
              if (stopped || writing) return;
              check();
              blocked = false;
              drainPending();
              if (ended) complete();
              else resume();
            } catch (error) {
              fail(error);
            }
          },
        ]) as () => void
    );
    if (options.endOnSourceEOF) {
      const onEnd = (options.source as RequestBody).onEnd;
      check();
      register(
        () =>
          Reflect.apply(onEnd, options.source, [
            () => {
              try {
                if (stopped) return;
                check();
                ended = true;
                complete();
              } catch (error) {
                fail(error);
              }
            },
          ]) as () => void
      );
    }
    if (options.resumeOnStart) resume();
  } catch (error) {
    fail(error);
  }
  return {
    stop,
    snapshot() {
      return { total, queued, blocked };
    },
  };
}
