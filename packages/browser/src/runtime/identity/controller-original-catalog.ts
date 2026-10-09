import type { ConnectOverCDPTransport } from 'playwright-core';
/** Original default context and bounded target snapshot on the attributed controller wire. */
export async function readControllerOriginalCatalog(transport: ConnectOverCDPTransport) {
  if (transport.onmessage || transport.onclose) throw new Error('CONTROLLER_CATALOG_ALREADY_OWNED');
  const send = transport.send.bind(transport);
  let sequence = 0;
  let first: Readonly<{ value: unknown }> | undefined;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const reject = (value: unknown) => {
    first ??= { value };
    for (const original of pending.values()) {
      clearTimeout(original.timer);
      original.reject(first.value);
    }
    pending.clear();
  };
  const receiveOriginal = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      reject(new Error('CONTROLLER_CATALOG_MESSAGE_INVALID'));
      return;
    }
    const message = value as Record<string, unknown>;
    const id = message.id;
    if (typeof id !== 'number') return;
    const original = pending.get(id);
    if (!original) {
      reject(new Error('CONTROLLER_CATALOG_ACK_FOREIGN'));
      return;
    }
    // Read all original reply fields while its rejection duty is still banked.
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    const error = hasError ? message.error : undefined;
    const result = hasError ? undefined : message.result;
    const sessionId = hasError ? undefined : message.sessionId;
    pending.delete(id);
    clearTimeout(original.timer);
    if (hasError) {
      first ??= { value: error };
      original.reject(first.value);
    } else if (
      sessionId !== undefined ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      first ??= { value: new Error('CONTROLLER_CATALOG_REPLY_INVALID') };
      original.reject(first.value);
    } else original.resolve(result as Record<string, unknown>);
  };
  const closed = (value?: unknown) =>
    reject(value === undefined ? new Error('CONTROLLER_CATALOG_CHANNEL_CLOSED') : value);
  const receive = (value: unknown) => {
    try {
      receiveOriginal(value);
    } catch (value) {
      reject(value);
    }
  };
  const command = (method: string) =>
    new Promise<Record<string, unknown>>((resolve, fail) => {
      if (first) {
        fail(first.value);
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error('CONTROLLER_CATALOG_ACK_UNOBSERVED')), 5000);
      pending.set(id, { resolve, reject: fail, timer });
      try {
        send({ id, method, params: {} });
      } catch (value) {
        reject(value);
      }
    });
  let observed:
    | Readonly<{
        context: string;
        targets: readonly Readonly<{ id: string; type: string; context: string | undefined }>[];
      }>
    | undefined;
  try {
    transport.onmessage = receive;
    transport.onclose = closed;
    const contexts = await command('Target.getBrowserContexts');
    if (!Array.isArray(contexts.browserContextIds) || contexts.browserContextIds.length)
      throw new Error('CONTROLLER_CATALOG_PREEXISTING_CONTEXT');
    const defaultContext = contexts.defaultBrowserContextId;
    if (typeof defaultContext !== 'string' || !defaultContext || defaultContext.length > 1024)
      throw new Error('CONTROLLER_CATALOG_DEFAULT_UNOBSERVED');
    const targets = await command('Target.getTargets');
    if (!Array.isArray(targets.targetInfos) || targets.targetInfos.length > 4096)
      throw new Error('CONTROLLER_CATALOG_TARGETS_INVALID');
    const ids = new Set<string>();
    const rows: Readonly<{ id: string; type: string; context: string | undefined }>[] = [];
    for (const value of targets.targetInfos) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('CONTROLLER_CATALOG_TARGET_INVALID');
      const target = value as Record<string, unknown>;
      const id = target.targetId,
        type = target.type,
        context = target.browserContextId;
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 1024 ||
        ids.has(id) ||
        typeof type !== 'string' ||
        !type ||
        type.length > 256 ||
        (context !== undefined && (typeof context !== 'string' || context !== defaultContext))
      )
        throw new Error('CONTROLLER_CATALOG_TARGET_INVALID');
      ids.add(id);
      rows.push(Object.freeze({ id, type, context }));
    }
    if (first) throw first.value;
    observed = Object.freeze({ context: defaultContext, targets: Object.freeze(rows) });
  } catch (value) {
    reject(value);
  } finally {
    // Synchronous requests are bounded and fully correlated before lending this exact receiver.
    if (!pending.size) {
      try {
        if (transport.onmessage === receive) transport.onmessage = undefined;
      } catch (value) {
        reject(value);
      }
      try {
        if (transport.onclose === closed) transport.onclose = undefined;
      } catch (value) {
        reject(value);
      }
    }
  }
  if (first) throw first.value;
  if (!observed) throw new Error('CONTROLLER_CATALOG_UNOBSERVED');
  return observed;
}
