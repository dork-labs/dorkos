import { createOriginalProxyAuthenticationDiagnostic } from './supervisor-uncertainty-diagnostic.js';
const retained = new Set<object>();
/** Private CDP lifetime on the exact already-attributed browser root endpoint. */
export async function ownPrivateProxyAuthentication(
  endpoint: string,
  peer: Readonly<{ url: string; credentials: Readonly<{ username: string; password: string }> }>,
  failed: () => void
) {
  const proxy = new URL(peer.url);
  if (
    proxy.origin !== peer.url ||
    proxy.protocol !== 'http:' ||
    proxy.hostname !== '127.0.0.1' ||
    !proxy.port
  )
    throw new Error('PROXY_AUTH_PEER_INVALID');
  const authDiagnostic = createOriginalProxyAuthenticationDiagnostic();
  const socket = new WebSocket(endpoint);
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const tasks = new Set<Promise<void>>();
  const sessions = new Set<string>();
  const fetchFrames = new Set<string>();
  const workerParents = new Map<string, string>();
  const coveredWorker = (sessionId: string): boolean => {
    const visited = new Set<string>();
    let current = sessionId;
    while (sessions.has(current) && visited.size < 128 && !visited.has(current)) {
      if (fetchFrames.has(current)) return true;
      visited.add(current);
      const parent = workerParents.get(current);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };
  const attempts = new Set<string>();
  const originalOwner = { socket, pending, tasks, sessions, fetchFrames, workerParents };
  retained.add(originalOwner);
  let sequence = 0,
    stopping = false,
    retiring = false,
    uncertain = false,
    firstFailure: Readonly<{ value: unknown }> | undefined,
    closing: Promise<void> | undefined,
    preparing: Promise<void> | undefined;
  const terminal = new Promise<void>((resolve) =>
    socket.addEventListener(
      'close',
      () => {
        if (!stopping) fault();
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('PROXY_AUTH_CHANNEL_CLOSED'));
        }
        pending.clear();
        resolve();
      },
      { once: true }
    )
  );
  const targetTypes = new Set([
    'page',
    'iframe',
    'worker',
    'shared_worker',
    'service_worker',
    'worklet',
    'auction_worklet',
    'background_page',
    'webview',
    'browser',
    'tab',
    'other',
  ]);
  function fault() {
    if (uncertain) return;
    uncertain = true;
    failed();
  }
  function send(method: string, params: object, sessionId?: string): Promise<unknown> {
    if (
      stopping ||
      uncertain ||
      socket.readyState !== WebSocket.OPEN ||
      pending.size >= 128 ||
      sequence >= Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(new Error('PROXY_AUTH_CHANNEL_UNAVAILABLE'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('PROXY_AUTH_METHOD_TIMEOUT'));
        fault();
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('PROXY_AUTH_SEND_FAILED'));
        fault();
      }
    });
  }
  const filters = [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}];
  async function attach(sessionId: string, targetType: string, parentSessionId?: string) {
    if (sessions.has(sessionId) || sessions.size >= 128)
      throw new Error('PROXY_AUTH_TARGET_UNAVAILABLE');
    sessions.add(sessionId);
    if (targetType === 'worker') {
      // Chromium153 has no dedicated-worker FetchHandler. Its subresource factory
      // uses the ancestor frame's handler; only an ACKed exact live parent chain
      // can cover this paused original worker. No unsupported-error fallback.
      if (!parentSessionId || !coveredWorker(parentSessionId))
        throw new Error('PROXY_AUTH_WORKER_PARENT_UNAVAILABLE');
      workerParents.set(sessionId, parentSessionId);
    } else {
      await send(
        'Fetch.enable',
        { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] },
        sessionId
      );
      if (targetType === 'page' || targetType === 'iframe') fetchFrames.add(sessionId);
      authDiagnostic.emit('PROXY_AUTH_FETCH_ENABLED');
    }
    await send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: filters },
      sessionId
    );
    if (targetType === 'worker' && !coveredWorker(sessionId))
      throw new Error('PROXY_AUTH_WORKER_PARENT_UNAVAILABLE');
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  function own(task: Promise<void>) {
    if (tasks.size >= 128) {
      fault();
      void task.catch(() => {});
      return;
    }
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      (value) => {
        firstFailure ??= { value };
        tasks.delete(task);
        if (!stopping) fault();
      }
    );
  }
  socket.addEventListener('error', () => {
    if (!stopping) fault();
  });
  socket.addEventListener('message', (event) => {
    if (stopping || uncertain) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 65536) {
      fault();
      authDiagnostic.emit('PROXY_AUTH_MESSAGE_INVALID');
      return;
    }
    let value: {
      id?: number;
      error?: unknown;
      result?: unknown;
      method?: string;
      sessionId?: string;
      params?: Record<string, unknown>;
    };
    try {
      value = JSON.parse(event.data) as typeof value;
    } catch {
      fault();
      authDiagnostic.emit('PROXY_AUTH_MESSAGE_INVALID');
      return;
    }
    if (!value || typeof value !== 'object') {
      fault();
      authDiagnostic.emit('PROXY_AUTH_MESSAGE_INVALID');
      return;
    }
    if (typeof value.id === 'number') {
      const original = pending.get(value.id);
      if (!original) {
        fault();
        return;
      }
      pending.delete(value.id);
      clearTimeout(original.timer);
      if (value.error) original.reject(new Error('PROXY_AUTH_METHOD_REFUSED'));
      else original.resolve(value.result);
      return;
    }
    const params = value.params;
    // Exact detachment facts can revoke an entered worker continuation during drain.
    // They create no new target, request, credentials or cleanup authority.
    if (value.method === 'Target.detachedFromTarget') {
      if (params && typeof params.sessionId === 'string') {
        sessions.delete(params.sessionId);
        fetchFrames.delete(params.sessionId);
        workerParents.delete(params.sessionId);
      }
      return;
    }
    // Original pending replies above remain consumed while new event producers are fenced.
    if (retiring) return;
    if (value.method === 'Target.attachedToTarget') {
      if (!params || typeof params.sessionId !== 'string') {
        fault();
        authDiagnostic.emit('PROXY_AUTH_EVENT_INVALID');
        return;
      }
      const info = params.targetInfo;
      const type = info && typeof info === 'object' ? (info as { type?: unknown }).type : undefined;
      own(
        attach(
          params.sessionId,
          typeof type === 'string' && targetTypes.has(type) ? type : 'unknown',
          value.sessionId
        )
      );
      authDiagnostic.emit('PROXY_AUTH_TARGET_ATTACHED');
    } else if (value.method === 'Fetch.requestPaused') {
      if (!params || typeof params.requestId !== 'string' || !value.sessionId) {
        fault();
        authDiagnostic.emit('PROXY_AUTH_EVENT_INVALID');
        return;
      }
      if (!sessions.has(value.sessionId)) {
        fault();
        authDiagnostic.emit('PROXY_AUTH_EVENT_SESSION_UNKNOWN');
        return;
      }
      own(
        send('Fetch.continueRequest', { requestId: params.requestId }, value.sessionId).then(
          () => {}
        )
      );
      authDiagnostic.emit('PROXY_AUTH_REQUEST_PAUSED');
    } else if (value.method === 'Fetch.authRequired') {
      if (!params || typeof params.requestId !== 'string' || !value.sessionId) {
        fault();
        authDiagnostic.emit('PROXY_AUTH_EVENT_INVALID');
        return;
      }
      if (!sessions.has(value.sessionId)) {
        fault();
        authDiagnostic.emit('PROXY_AUTH_EVENT_SESSION_UNKNOWN');
        return;
      }
      const challenge = params.authChallenge as { source?: string; origin?: string } | undefined;
      const attempt = `${value.sessionId}:${params.requestId}`;
      const first = !attempts.has(attempt);
      let exact = false;
      let proxySource: boolean | undefined, originMatch: boolean | undefined;
      attempts.add(attempt);
      if (attempts.size > 4096) {
        fault();
        return;
      }
      try {
        exact =
          first &&
          (proxySource = challenge?.source === 'Proxy') &&
          (originMatch = new URL(challenge.origin!).origin === peer.url);
      } catch {
        /* Refuse unknown challenges. */
      }
      const authOriginal = send(
        'Fetch.continueWithAuth',
        {
          requestId: params.requestId,
          authChallengeResponse: exact
            ? {
                response: 'ProvideCredentials',
                username: peer.credentials.username,
                password: peer.credentials.password,
              }
            : { response: 'CancelAuth' },
        },
        value.sessionId
      ).then(() => {});
      own(authOriginal);
      authDiagnostic.emit(
        !first
          ? 'PROXY_AUTH_CHALLENGE_REPEAT'
          : !proxySource
            ? 'PROXY_AUTH_CHALLENGE_NOT_PROXY'
            : originMatch === undefined
              ? 'PROXY_AUTH_CHALLENGE_ORIGIN_INVALID'
              : originMatch
                ? 'PROXY_AUTH_CHALLENGE_EXACT'
                : 'PROXY_AUTH_CHALLENGE_ORIGIN_MISMATCH'
      );
      void authOriginal.then(
        () => authDiagnostic.emit('PROXY_AUTH_ACK_OBSERVED'),
        () => authDiagnostic.emit('PROXY_AUTH_ACK_REFUSED')
      );
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PROXY_AUTH_OPEN_TIMEOUT')), 3000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('PROXY_AUTH_OPEN_FAILED'));
      },
      { once: true }
    );
  });
  const prepareClose = () => {
    if (preparing) return preparing;
    retiring = true;
    // Publish before any retained original or close receiver can reenter.
    preparing = Promise.resolve().then(async () => {
      // Entered attach/Fetch chains retain their original ACKs and 3s command bounds.
      // New event producers are fenced; only already retained tasks can continue sends.
      while (tasks.size) {
        const results = await Promise.allSettled([...tasks]);
        for (const result of results)
          if (result.status === 'rejected') firstFailure ??= { value: result.reason };
      }
      stopping = true;
      try {
        socket.close();
      } catch (value) {
        firstFailure ??= { value };
      }
      if (firstFailure) throw firstFailure.value;
    });
    void preparing.catch(() => {});
    return preparing;
  };
  const close = () => {
    if (closing) return closing;
    const entry = prepareClose();
    closing = Promise.resolve().then(async () => {
      // Entry rejection cannot skip the original terminal join, and the terminal
      // cannot block the independent browser stop that may be needed to end it.
      await entry.catch(() => {});
      await terminal;
      if (firstFailure) throw firstFailure.value;
      if (uncertain) throw new Error('PROXY_AUTH_CUSTODY_UNCERTAIN');
      retained.delete(originalOwner);
    });
    void closing.catch(() => {});
    return closing;
  };
  authDiagnostic.emit('PROXY_AUTH_OWNER_ENTERED');
  try {
    await opened;
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: filters,
    });
    // Autoattach emits current targets before its original command reply; settle their retained initialization.
    while (tasks.size) await Promise.all([...tasks]);
    if (uncertain) throw new Error('PROXY_AUTH_CUSTODY_UNCERTAIN');
    authDiagnostic.emit('PROXY_AUTH_READY');
  } catch (error) {
    fault();
    void close().catch(() => {});
    throw error;
  }
  return Object.freeze({
    isCustodyKnown: () =>
      !retiring && !stopping && !uncertain && socket.readyState === WebSocket.OPEN,
    prepareClose,
    close,
  });
}

/** Enter the independent original browser stop after auth drain/close entry settles, even on refusal. */
export async function joinOriginalProxyAuthenticationStop(
  authenticationEntry: Promise<void>,
  stopOriginalBrowser: () => Promise<unknown>
): Promise<void> {
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    await authenticationEntry;
  } catch (value) {
    first = { value };
  }
  try {
    await stopOriginalBrowser();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
