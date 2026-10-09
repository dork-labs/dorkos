type Message = Record<string, unknown>;
const object = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);
type Method = 'fetch-enable-auth' | 'fetch-enable-other' | 'fetch-disable';
type Role = 'page' | 'iframe' | 'worker' | 'service_worker' | 'shared_worker' | 'unowned';

/** Fixed observations of existing SDK producers; no command or settlement authority. */
export function createControllerFetchStages(write: (value: string) => unknown) {
  const sink = write;
  const emitted = new Set<string>();
  const pending = new Map<number, Readonly<{ method: Method; session: string }>>();
  const emit = (stage: string) => {
    try {
      if (emitted.has(stage) || emitted.size >= 32) return;
      emitted.add(stage);
      sink(
        'Browser original controller Fetch stage ' +
          JSON.stringify({ ordinal: emitted.size, stage }) +
          '\n'
      );
    } catch {
      /* Optional diagnostics never change the original producer. */
    }
  };
  return Object.freeze({
    entering(value: Message) {
      try {
        const method: Method | undefined =
          value.method === 'Fetch.disable'
            ? 'fetch-disable'
            : value.method === 'Fetch.enable'
              ? object(value.params) && value.params.handleAuthRequests === true
                ? 'fetch-enable-auth'
                : 'fetch-enable-other'
              : undefined;
        if (!method) return;
        if (
          typeof value.id === 'number' &&
          Number.isSafeInteger(value.id) &&
          value.id > 0 &&
          typeof value.sessionId === 'string' &&
          value.sessionId.length <= 1024 &&
          !pending.has(value.id) &&
          pending.size < 128
        )
          pending.set(value.id, Object.freeze({ method, session: value.sessionId }));
        return method;
      } catch {
        /* Retention is bounded and observational only. */
      }
    },
    entered(method: Method | undefined) {
      if (method) emit(method + '-entered');
    },
    observe(value: Message, role: Role) {
      try {
        if (typeof value.id === 'number') {
          const command = pending.get(value.id);
          if (command && value.sessionId === command.session) {
            pending.delete(value.id);
            emit(
              command.method +
                (Object.prototype.hasOwnProperty.call(value, 'error')
                  ? '-ack-refused'
                  : object(value.result)
                    ? '-ack-observed'
                    : '-ack-invalid')
            );
          }
        }
        if (value.method === 'Fetch.requestPaused') emit('request-paused-' + role);
      } catch {
        /* SDK event and ACK forwarding remains unchanged. */
      }
    },
    close() {
      pending.clear();
    },
  });
}
