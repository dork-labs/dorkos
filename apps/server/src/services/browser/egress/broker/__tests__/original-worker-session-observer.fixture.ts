import type { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';

type Transport = Parameters<typeof createControllerProxyAuthentication>[0];
type WorkerSession = Readonly<{
  target: string;
  session: string;
  context: string;
  url: string;
  parent: string | undefined;
}>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;

/** Retain exact SDK sessions and detach through their original parent on the same private wire. */
export function observeOriginalSDKWorkerSessions(
  original: Transport,
  defaultContext: string,
  current: () => void
) {
  if (!id(defaultContext) || original.onmessage || original.onclose)
    throw new Error('ORIGINAL_WORKER_OBSERVER_CUSTODY_REQUIRED');
  const openOriginal = original.open?.bind(original);
  const sendOriginal = original.send.bind(original);
  const closeOriginal = original.close.bind(original);
  const jobs = new Set<Promise<void>>();
  const sessions = new Map<string, WorkerSession>();
  const owned = new WeakSet<WorkerSession>();
  const acknowledgements = new Map<
    number,
    { parent: string | undefined; done(): void; refuse(value: unknown): void }
  >();
  const privateIds = new Set<number>();
  // Chromium crdtp accepts only int32 command IDs. Reserve 32 IDs away from
  // ordinary positive SDK IDs and the controller's descending -1 command bank.
  const firstPrivateId = -2_147_482_624;
  const lastPrivateId = firstPrivateId + 31;
  let next = firstPrivateId;
  const waiters = new Map<
    string,
    { done(): void; refuse(value: unknown): void; original: Promise<void> }
  >();
  let first: { value: unknown } | undefined;
  let message: Transport['onmessage'];
  let close: Transport['onclose'];
  const originalFailure = (): { value: unknown } | undefined => first;
  const fail = (value: unknown) => {
    first ??= { value };
    for (const pending of waiters.values()) pending.refuse(first.value);
    for (const pending of acknowledgements.values()) pending.refuse(first.value);
  };
  const inspect = (packet: unknown) => {
    try {
      if (first || !object(packet) || !object(packet.params)) return;
      const params = packet.params;
      if (
        packet.method === 'Target.attachedToTarget' &&
        id(params.sessionId) &&
        object(params.targetInfo)
      ) {
        const info = params.targetInfo;
        const hasParent = Object.prototype.hasOwnProperty.call(packet, 'sessionId');
        const parent = hasParent ? packet.sessionId : undefined;
        if (
          info.type !== 'service_worker' ||
          info.browserContextId !== defaultContext ||
          !id(info.targetId) ||
          typeof info.url !== 'string' ||
          info.url.length > 4096 ||
          (hasParent && !id(parent))
        )
          return;
        if (sessions.size >= 64 || sessions.has(params.sessionId))
          throw new Error('ORIGINAL_WORKER_SESSION_BOUND');
        const captured = Object.freeze({
          target: info.targetId,
          session: params.sessionId,
          context: defaultContext,
          url: info.url,
          parent: typeof parent === 'string' ? parent : undefined,
        });
        owned.add(captured);
        sessions.set(captured.session, captured);
      }
      if (packet.method === 'Target.detachedFromTarget' && id(params.sessionId)) {
        const retained = sessions.get(params.sessionId);
        if (
          retained &&
          (Object.prototype.hasOwnProperty.call(packet, 'sessionId')
            ? packet.sessionId
            : undefined) === retained.parent
        ) {
          sessions.delete(params.sessionId);
          waiters.get(params.sessionId)?.done();
        }
      }
    } catch (value) {
      fail(value);
    }
  };
  const consumeOriginalACK = (packet: unknown) => {
    if (!object(packet)) return false;
    const field = Object.getOwnPropertyDescriptor(packet, 'id');
    if (!field || !('value' in field) || !privateIds.has(field.value)) return false;
    const pending = acknowledgements.get(field.value);
    try {
      if (!pending) throw new Error('ORIGINAL_WORKER_ACK_UNOWNED');
      const hasParent = Object.prototype.hasOwnProperty.call(packet, 'sessionId');
      if (
        pending.parent === undefined ? hasParent : !hasParent || packet.sessionId !== pending.parent
      )
        throw new Error('ORIGINAL_WORKER_ACK_PARENT_REQUIRED');
      if (Object.prototype.hasOwnProperty.call(packet, 'error')) throw packet.error;
      if (!object(packet.result)) throw new Error('ORIGINAL_WORKER_DETACH_ACK_REQUIRED');
      pending.done();
    } catch (value) {
      fail(value);
    }
    acknowledgements.delete(field.value);
    return true;
  };
  const transport: Transport = {
    open: () => openOriginal?.(),
    send(packet) {
      if (
        object(packet) &&
        typeof packet.id === 'number' &&
        packet.id >= firstPrivateId &&
        packet.id <= lastPrivateId
      )
        throw new Error('ORIGINAL_WORKER_COMMAND_ID_COLLISION');
      sendOriginal(packet);
    },
    close: closeOriginal,
    get onmessage() {
      return message;
    },
    set onmessage(value) {
      message = value;
      original.onmessage = value
        ? (packet) => {
            if (consumeOriginalACK(packet)) return;
            try {
              value(packet);
            } finally {
              inspect(packet);
            }
          }
        : undefined;
    },
    get onclose() {
      return close;
    },
    set onclose(value) {
      close = value;
      original.onclose = value
        ? (...args) => {
            try {
              value(...args);
            } finally {
              fail(new Error('ORIGINAL_WORKER_WIRE_CLOSED'));
            }
          }
        : undefined;
    },
  };
  return Object.freeze({
    transport,
    sessions() {
      if (first) throw first.value;
      current();
      return Object.freeze([...sessions.values()]);
    },
    detach(captured: WorkerSession) {
      if (jobs.size >= 32 || privateIds.size >= 32)
        return Promise.reject(new Error('ORIGINAL_WORKER_DETACH_BOUND'));
      const work = Promise.resolve().then(async () => {
        if (first) throw first.value;
        current();
        if (
          !owned.has(captured) ||
          sessions.get(captured.session) !== captured ||
          waiters.has(captured.session)
        )
          throw new Error('ORIGINAL_SDK_WORKER_SESSION_REQUIRED');
        let done!: () => void;
        let refuse!: (value: unknown) => void;
        const original = new Promise<void>((yes, no) => {
          done = yes;
          refuse = no;
        });
        void original.catch(() => {});
        waiters.set(captured.session, { done, refuse, original });
        const commandId = next++;
        privateIds.add(commandId);
        let ackDone!: () => void, ackRefuse!: (value: unknown) => void;
        const ack = new Promise<void>((yes, no) => {
          ackDone = yes;
          ackRefuse = no;
        });
        void ack.catch(() => {});
        acknowledgements.set(commandId, {
          parent: captured.parent,
          done: ackDone,
          refuse: ackRefuse,
        });
        let firstDetach: { value: unknown } | undefined;
        try {
          sendOriginal({
            id: commandId,
            method: 'Target.detachFromTarget',
            params: { sessionId: captured.session },
            ...(captured.parent === undefined ? {} : { sessionId: captured.parent }),
          });
          await ack;
        } catch (value) {
          firstDetach = first ?? { value };
          ackRefuse(firstDetach.value);
          refuse(firstDetach.value);
        }
        acknowledgements.delete(commandId);
        try {
          await original;
        } catch (value) {
          firstDetach ??= { value };
        }
        waiters.delete(captured.session);
        if (firstDetach) throw firstDetach.value;
        const retainedFailure = originalFailure();
        if (retainedFailure) throw retainedFailure.value;
        current();
        if (sessions.has(captured.session))
          throw new Error('ORIGINAL_WORKER_DETACH_EVENT_REQUIRED');
      });
      jobs.add(work);
      void work.then(
        () => jobs.delete(work),
        () => jobs.delete(work)
      );
      return work;
    },
    async close() {
      fail(new Error('ORIGINAL_WORKER_OBSERVER_CLOSED'));
      await Promise.allSettled([...jobs, ...[...waiters.values()].map((row) => row.original)]);
    },
  });
}
