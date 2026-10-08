import { createControllerFetchStages } from './controller-fetch-stages.js';
import type { ConnectOverCDPTransport } from 'playwright-core';

type Message = Record<string, unknown>;
const record = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const opaque = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
type Target = Readonly<{ admitted: boolean; type: string; context: string | undefined }>;
type Session = Readonly<{ target: string; parent?: string; admitted: boolean }>;

/** Same original controller wire: SDK routing remains intact; its proxy challenges have one owner. */
export function createControllerProxyAuthentication(
  original: ConnectOverCDPTransport,
  peer: Readonly<{ url: string; credentials: Readonly<{ username: string; password: string }> }>,
  current: () => boolean,
  failed: (value: unknown) => void,
  originalDefault: Readonly<{
    context: string;
    targets: readonly Readonly<{ id: string; type: string; context: string | undefined }>[];
  }>,
  diagnosticWrite?: (value: string) => unknown
) {
  const defaultContext = originalDefault.context;
  const initialTargets = originalDefault.targets;
  if (!opaque(defaultContext) || !Array.isArray(initialTargets) || initialTargets.length > 4096)
    throw new Error('CONTROLLER_AUTH_CATALOG_INVALID');
  const proxy = new URL(peer.url),
    credentials = Object.freeze({ ...peer.credentials });
  if (
    proxy.protocol !== 'http:' ||
    proxy.hostname !== '127.0.0.1' ||
    !proxy.port ||
    proxy.origin !== peer.url ||
    credentials.username !== 'dorkos' ||
    typeof credentials.password !== 'string' ||
    !credentials.password.length ||
    credentials.password.length > 4096 ||
    original.onmessage ||
    original.onclose
  )
    throw new Error('CONTROLLER_AUTH_ORIGINAL_REFUSED');
  const opening = original.open;
  if (typeof opening !== 'function') throw new Error('CONTROLLER_AUTH_OPEN_UNAVAILABLE');
  const openOriginal = opening.bind(original),
    sendOriginal = original.send.bind(original),
    closeOriginal = original.close.bind(original),
    isCurrent = current,
    failOriginal = failed;
  type Decision =
    | 'provide'
    | 'repeat'
    | 'session'
    | 'authority'
    | 'source'
    | 'origin-type'
    | 'origin-mismatch'
    | 'origin-invalid'
    | 'challenge-invalid'
    | 'ack-observed'
    | 'ack-refused'
    | 'original-fault'
    | 'send-refused'
    | 'ack-unobserved';
  const emitted = new Set<Decision>();
  let diagnosticSink: ((value: string) => unknown) | undefined;
  try {
    diagnosticSink = diagnosticWrite ?? process.stderr.write.bind(process.stderr);
  } catch {
    /* Diagnostics have no authority. */
  }
  const emit = (decision: Decision) => {
    try {
      if (emitted.has(decision) || emitted.size >= 16) return;
      emitted.add(decision);
      diagnosticSink?.(
        'Browser original controller proxy authentication diagnostic ' +
          JSON.stringify({ ordinal: emitted.size, decision }) +
          '\n'
      );
    } catch {
      /* The original decision and producer cause stay unchanged. */
    }
  };
  const fetchStages = createControllerFetchStages((value) => diagnosticSink?.(value));
  const sessions = new Map<string, Session>();
  const targets = new Map<string, Target>();
  for (const info of initialTargets) {
    if (
      !opaque(info.id) ||
      !opaque(info.type) ||
      targets.has(info.id) ||
      (info.context !== undefined && info.context !== defaultContext)
    )
      throw new Error('CONTROLLER_AUTH_CATALOG_INVALID');
    targets.set(
      info.id,
      Object.freeze({
        admitted:
          ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(info.type) &&
          info.context === defaultContext,
        type: info.type,
        context: info.context,
      })
    );
  }
  const attachments = new Map<number, string>();
  const targetReads = new Set<number>();
  const attempts = new Set<string>();
  const pending = new Map<
    number,
    {
      session: string;
      method: 'Fetch.continueWithAuth' | 'Fetch.enable';
      resolve(): void;
      reject(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const tasks = new Set<Promise<void>>();
  const workerReady = new Map<string, Promise<void>>();
  let next = -1,
    retiring = false,
    closed = false;
  let first: Readonly<{ value: unknown }> | undefined;
  let preparation: Promise<void> | undefined, closing: Promise<void> | undefined;
  const note = (value: unknown) => {
    if (first) return;
    first = Object.freeze({ value });
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(value);
    }
    pending.clear();
    try {
      failOriginal(value);
    } catch {
      /* Original failure is already retained. */
    }
  };
  const target = (value: unknown): string | undefined => {
    if (!record(value) || !opaque(value.targetId)) return;
    const type = typeof value.type === 'string' ? value.type : '';
    const context = value.browserContextId;
    if (context !== undefined && !opaque(context))
      throw new Error('CONTROLLER_AUTH_TARGET_INVALID');
    const admitted =
      ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(type) &&
      context === defaultContext;
    const existing = targets.get(value.targetId);
    if (existing && (existing.type !== type || existing.context !== context)) {
      for (const [id, info] of sessions) if (info.target === value.targetId) detach(id);
      throw new Error('CONTROLLER_AUTH_TARGET_CHANGED');
    }
    if (!targets.has(value.targetId) && targets.size >= 4096)
      throw new Error('CONTROLLER_AUTH_TARGET_CAPACITY');
    targets.set(value.targetId, Object.freeze({ admitted, type, context }));
    return value.targetId;
  };
  const enroll = (id: unknown, targetId: string | undefined, parent?: string) => {
    if (!opaque(id) || !targetId || (parent !== undefined && !opaque(parent)))
      throw new Error('CONTROLLER_AUTH_SESSION_INVALID');
    const existing = sessions.get(id);
    if (existing) {
      if (existing.target !== targetId || existing.parent !== parent)
        throw new Error('CONTROLLER_AUTH_SESSION_REBOUND');
      return;
    }
    if (sessions.size >= 4096) throw new Error('CONTROLLER_AUTH_SESSION_CAPACITY');
    sessions.set(
      id,
      Object.freeze({
        target: targetId,
        ...(parent ? { parent } : {}),
        admitted:
          targets.get(targetId)?.admitted === true &&
          (!parent || sessions.get(parent)?.admitted === true),
      })
    );
  };
  const detach = (id: string) => {
    const removing = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [child, info] of sessions)
        if (info.parent && removing.has(info.parent) && !removing.has(child)) {
          removing.add(child);
          changed = true;
        }
    }
    for (const child of removing) {
      sessions.delete(child);
      workerReady.delete(child);
    }
  };
  const ownSend = (
    session: string,
    params: Message,
    method: 'Fetch.continueWithAuth' | 'Fetch.enable' = 'Fetch.continueWithAuth'
  ) => {
    if (
      retiring ||
      first ||
      tasks.size >= 128 ||
      pending.size >= 128 ||
      next <= Number.MIN_SAFE_INTEGER
    )
      throw first ? first.value : new Error('CONTROLLER_AUTH_ADMISSION_CLOSED');
    const id = next--;
    let resolve!: () => void, reject!: (value: unknown) => void;
    const task = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      (value) => {
        note(value);
        tasks.delete(task);
      }
    );
    const timer = setTimeout(() => {
      pending.delete(id);
      const value = new Error('CONTROLLER_AUTH_ACK_UNOBSERVED');
      reject(value);
      note(value);
      emit('ack-unobserved');
    }, 3000);
    pending.set(id, { session, method, resolve, reject, timer });
    try {
      sendOriginal({ id, method, params, sessionId: session });
    } catch (value) {
      pending.delete(id);
      clearTimeout(timer);
      reject(value);
      note(value);
      emit('send-refused');
    }
    return task;
  };
  const resumeWorker = (value: Message, sessionId: string, session: Session) => {
    if (tasks.size >= 128) throw new Error('CONTROLLER_AUTH_WORKER_RESUME_CAPACITY');
    const admit = () => {
      if (first) throw first.value;
      if (retiring || closed || !isCurrent() || sessions.get(sessionId) !== session)
        throw new Error('CONTROLLER_AUTH_WORKER_RESUME_REFUSED');
    };
    // Retain the SDK's exact original resume before the first asynchronous producer.
    // The worker's own Fetch handler must acknowledge authentication before it runs.
    const original = Promise.resolve().then(async () => {
      admit();
      let ready = workerReady.get(sessionId);
      if (!ready) {
        ready = ownSend(
          sessionId,
          {
            handleAuthRequests: true,
            patterns: [{ urlPattern: '*' }],
          },
          'Fetch.enable'
        );
        workerReady.set(sessionId, ready);
      }
      await ready;
      admit();
      sendOriginal(value);
    });
    tasks.add(original);
    void original.then(
      () => tasks.delete(original),
      (value) => {
        note(value);
        tasks.delete(original);
      }
    );
  };
  const transport: ConnectOverCDPTransport = {
    open() {
      openOriginal();
    },
    send(value) {
      if (!record(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0)
        throw new Error('CONTROLLER_AUTH_SDK_ID_REFUSED');
      if (
        value.method === 'Target.attachToTarget' &&
        record(value.params) &&
        opaque(value.params.targetId)
      ) {
        if (attachments.size >= 128 || attachments.has(Number(value.id)))
          throw new Error('CONTROLLER_AUTH_ATTACH_CAPACITY');
        attachments.set(Number(value.id), value.params.targetId);
      }
      if (value.method === 'Target.getTargetInfo') {
        if (targetReads.size >= 128 || targetReads.has(Number(value.id)))
          throw new Error('CONTROLLER_AUTH_READ_CAPACITY');
        targetReads.add(Number(value.id));
      }
      if (value.method === 'Runtime.runIfWaitingForDebugger' && opaque(value.sessionId)) {
        const session = sessions.get(value.sessionId);
        if (session?.admitted && targets.get(session.target)?.type === 'service_worker') {
          resumeWorker(value, value.sessionId, session);
          return;
        }
      }
      const fetchStage = fetchStages.entering(value);
      try {
        sendOriginal(value);
        fetchStages.entered(fetchStage);
      } catch (value) {
        note(value);
        throw value;
      }
    },
    close() {
      return close();
    },
  };
  original.onmessage = (value) => {
    try {
      if (!record(value)) throw new Error('CONTROLLER_AUTH_MESSAGE_INVALID');
      try {
        const stageSession =
          typeof value.sessionId === 'string' ? sessions.get(value.sessionId) : undefined;
        const stageTarget = stageSession?.admitted
          ? targets.get(stageSession.target)?.type
          : undefined;
        fetchStages.observe(
          value,
          stageTarget === 'page' ||
            stageTarget === 'iframe' ||
            stageTarget === 'worker' ||
            stageTarget === 'service_worker' ||
            stageTarget === 'shared_worker'
            ? stageTarget
            : 'unowned'
        );
      } catch {
        /* Diagnostic projection cannot fault the original SDK producer or forwarding. */
      }
      if (typeof value.id === 'number' && value.id < 0) {
        const task = pending.get(value.id);
        if (!task || value.sessionId !== task.session)
          throw new Error('CONTROLLER_AUTH_ACK_FOREIGN');
        if (!Object.prototype.hasOwnProperty.call(value, 'error') && !record(value.result))
          throw new Error('CONTROLLER_AUTH_ACK_INVALID');
        pending.delete(value.id);
        clearTimeout(task.timer);
        if (Object.prototype.hasOwnProperty.call(value, 'error')) {
          task.reject(value.error);
          note(value.error);
          if (task.method === 'Fetch.continueWithAuth') emit('ack-refused');
        } else {
          task.resolve();
          if (task.method === 'Fetch.continueWithAuth') emit('ack-observed');
        }
        return;
      }
      if (value.method === 'Target.targetCreated' || value.method === 'Target.targetInfoChanged')
        target(record(value.params) ? value.params.targetInfo : undefined);
      if (value.method === 'Target.attachedToTarget') {
        if (!record(value.params)) throw new Error('CONTROLLER_AUTH_SESSION_INVALID');
        enroll(
          value.params.sessionId,
          target(value.params.targetInfo),
          typeof value.sessionId === 'string' ? value.sessionId : undefined
        );
      }
      if (
        value.method === 'Target.targetDestroyed' &&
        record(value.params) &&
        typeof value.params.targetId === 'string'
      ) {
        targets.delete(value.params.targetId);
        for (const [id, info] of sessions) if (info.target === value.params.targetId) detach(id);
      }
      if (
        value.method === 'Target.detachedFromTarget' &&
        record(value.params) &&
        typeof value.params.sessionId === 'string'
      )
        detach(value.params.sessionId);
      if (typeof value.id === 'number' && targetReads.delete(value.id) && record(value.result))
        target(value.result.targetInfo);
      if (typeof value.id === 'number' && attachments.has(value.id)) {
        const targetId = attachments.get(value.id);
        attachments.delete(value.id);
        if (!Object.prototype.hasOwnProperty.call(value, 'error') && record(value.result))
          enroll(
            value.result.sessionId,
            targetId,
            typeof value.sessionId === 'string' ? value.sessionId : undefined
          );
      }
      if (value.method !== 'Fetch.authRequired') {
        transport.onmessage?.(value);
        return;
      }
      if (retiring || first) return;
      if (!record(value.params) || !opaque(value.params.requestId) || !opaque(value.sessionId))
        throw new Error('CONTROLLER_AUTH_CHALLENGE_INVALID');
      const params = value.params,
        session = value.sessionId;
      const attempt = JSON.stringify([session, params.requestId]);
      const initial = !attempts.has(attempt);
      if (attempts.size >= 4096) throw new Error('CONTROLLER_AUTH_ATTEMPTS_EXHAUSTED');
      attempts.add(attempt);
      const challenge = record(params.authChallenge) ? params.authChallenge : undefined;
      const admitted = isCurrent();
      let exact = false;
      let decision: Decision = 'repeat';
      try {
        if (initial) {
          decision = 'session';
          if (sessions.get(session)?.admitted === true) {
            decision = 'authority';
            if (admitted) {
              decision = 'source';
              if (challenge?.source === 'Proxy') {
                decision = 'origin-type';
                if (typeof challenge.origin === 'string') {
                  decision = 'origin-mismatch';
                  exact = new URL(challenge.origin).origin === proxy.origin;
                  if (exact) decision = 'provide';
                }
              }
            }
          }
        }
      } catch {
        exact = false;
        decision = decision === 'origin-mismatch' ? 'origin-invalid' : 'challenge-invalid';
      }
      ownSend(session, {
        requestId: params.requestId,
        authChallengeResponse: exact
          ? { response: 'ProvideCredentials', ...credentials }
          : { response: 'CancelAuth' },
      });
      emit(decision);
    } catch (value) {
      note(value);
      emit('original-fault');
    }
  };
  original.onclose = (...args) => {
    closed = true;
    fetchStages.close();
    if (!retiring) note(new Error('CONTROLLER_AUTH_WIRE_CLOSED'));
    if (pending.size) note(new Error('CONTROLLER_AUTH_ACK_UNOBSERVED'));
    transport.onclose?.(...args);
  };
  function prepareClose() {
    if (preparation) return preparation;
    retiring = true;
    preparation = Promise.resolve().then(async () => {
      await Promise.allSettled([...tasks]);
      if (first) throw first.value;
    });
    return preparation;
  }
  function close() {
    if (closing) return closing;
    retiring = true;
    closing = Promise.resolve().then(async () => {
      let failure = first;
      try {
        await prepareClose();
      } catch (value) {
        failure ??= Object.freeze({ value });
      }
      try {
        await closeOriginal();
      } catch (value) {
        failure ??= Object.freeze({ value });
      }
      if (failure) throw failure.value;
    });
    return closing;
  }
  return Object.freeze({
    transport,
    prepareClose,
    close,
    isKnown: () => !first && !retiring && !closed,
  });
}
