import type { ConnectOverCDPTransport } from 'playwright-core';
/** Exact owned initial default target, before either channel has an autoattach producer. */
export async function readSupervisorOriginalCatalog(transport: ConnectOverCDPTransport) {
  if (transport.onmessage || transport.onclose) throw new Error('SUPERVISOR_CATALOG_ALREADY_OWNED');
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
      reject(new Error('SUPERVISOR_CATALOG_MESSAGE_INVALID'));
      return;
    }
    const message = value as Record<string, unknown>;
    const id = message.id;
    if (typeof id !== 'number') return;
    const original = pending.get(id);
    if (!original) {
      reject(new Error('SUPERVISOR_CATALOG_ACK_FOREIGN'));
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
      first ??= { value: new Error('SUPERVISOR_CATALOG_REPLY_INVALID') };
      original.reject(first.value);
    } else original.resolve(result as Record<string, unknown>);
  };
  const closed = (value?: unknown) =>
    reject(value === undefined ? new Error('SUPERVISOR_CATALOG_CHANNEL_CLOSED') : value);
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
      const timer = setTimeout(() => reject(new Error('SUPERVISOR_CATALOG_ACK_UNOBSERVED')), 5000);
      pending.set(id, { resolve, reject: fail, timer });
      try {
        send({ id, method, params: {} });
      } catch (value) {
        reject(value);
      }
    });
  let observed: Readonly<{ id: string; context: string | undefined }> | undefined;
  try {
    transport.onmessage = receive;
    transport.onclose = closed;
    const contexts = await command('Target.getBrowserContexts');
    if (!Array.isArray(contexts.browserContextIds) || contexts.browserContextIds.length)
      throw new Error('SUPERVISOR_CATALOG_PREEXISTING_CONTEXT');
    const targets = await command('Target.getTargets');
    if (!Array.isArray(targets.targetInfos) || targets.targetInfos.length !== 1)
      throw new Error('SUPERVISOR_CATALOG_PREEXISTING_TARGET');
    const target = targets.targetInfos[0] as Record<string, unknown> | undefined;
    if (
      !target ||
      target.type !== 'page' ||
      target.url !== 'about:blank' ||
      typeof target.targetId !== 'string' ||
      !target.targetId ||
      target.targetId.length > 256 ||
      (target.browserContextId !== undefined && typeof target.browserContextId !== 'string')
    )
      throw new Error('SUPERVISOR_CATALOG_PREEXISTING_TARGET');
    if (first) throw first.value;
    observed = Object.freeze({
      id: target.targetId,
      context: target.browserContextId as string | undefined,
    });
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
  if (!observed) throw new Error('SUPERVISOR_CATALOG_UNOBSERVED');
  return observed;
}
