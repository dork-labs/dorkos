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
  const attempts = new Set<string>();
  const originalOwner = { socket, pending, tasks, sessions };
  retained.add(originalOwner);
  let sequence = 0,
    stopping = false,
    uncertain = false,
    closing: Promise<void> | undefined;
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
  async function attach(sessionId: string) {
    if (sessions.has(sessionId) || sessions.size >= 128)
      throw new Error('PROXY_AUTH_TARGET_UNAVAILABLE');
    sessions.add(sessionId);
    await send(
      'Fetch.enable',
      { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] },
      sessionId
    );
    await send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: filters },
      sessionId
    );
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
      () => {
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
      return;
    }
    if (!value || typeof value !== 'object') {
      fault();
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
    if (value.method === 'Target.attachedToTarget') {
      if (!params || typeof params.sessionId !== 'string') {
        fault();
        return;
      }
      own(attach(params.sessionId));
    } else if (value.method === 'Target.detachedFromTarget') {
      if (params && typeof params.sessionId === 'string') sessions.delete(params.sessionId);
    } else if (value.method === 'Fetch.requestPaused') {
      if (
        !params ||
        typeof params.requestId !== 'string' ||
        !value.sessionId ||
        !sessions.has(value.sessionId)
      ) {
        fault();
        return;
      }
      own(
        send('Fetch.continueRequest', { requestId: params.requestId }, value.sessionId).then(
          () => {}
        )
      );
    } else if (value.method === 'Fetch.authRequired') {
      if (
        !params ||
        typeof params.requestId !== 'string' ||
        !value.sessionId ||
        !sessions.has(value.sessionId)
      ) {
        fault();
        return;
      }
      const challenge = params.authChallenge as { source?: string; origin?: string } | undefined;
      const attempt = `${value.sessionId}:${params.requestId}`;
      const first = !attempts.has(attempt);
      let exact = false;
      attempts.add(attempt);
      if (attempts.size > 4096) {
        fault();
        return;
      }
      try {
        exact =
          first && challenge?.source === 'Proxy' && new URL(challenge.origin!).origin === peer.url;
      } catch {
        /* Refuse unknown challenges. */
      }
      own(
        send(
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
        ).then(() => {})
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
  const close = () => {
    if (closing) return closing;
    stopping = true;
    socket.close();
    closing = Promise.all([terminal, ...tasks]).then(() => {
      if (uncertain) throw new Error('PROXY_AUTH_CUSTODY_UNCERTAIN');
      retained.delete(originalOwner);
    });
    return closing;
  };
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
  } catch (error) {
    fault();
    void close().catch(() => {});
    throw error;
  }
  return Object.freeze({
    isCustodyKnown: () => !stopping && !uncertain && socket.readyState === WebSocket.OPEN,
    close,
  });
}
