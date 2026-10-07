import { createOriginalProxyAuthenticationDiagnostic } from '../supervisor-uncertainty-diagnostic.js';
import type { ConnectOverCDPTransport } from 'playwright-core';
type Message = Record<string, unknown>;
const record = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const retained = new Set<object>();

/** Private original proxy challenge consumer. Constructor captures the barrier transport;
 * it creates no socket and attaches its listener before the caller's first autoattach command.
 * The barrier owns target identity/recursive pause/resume. This owner owns only exact proxy
 * challenge responses and their original acknowledgements, never a readiness assertion.
 */
export function ownSupervisorProxyAuthentication(
  transport: ConnectOverCDPTransport,
  peer: Readonly<{ url: string; credentials: Readonly<{ username: string; password: string }> }>,
  failed: (value: unknown) => void
) {
  const proxy = new URL(peer.url);
  const credentials = Object.freeze({ ...peer.credentials });
  if (
    proxy.protocol !== 'http:' ||
    proxy.hostname !== '127.0.0.1' ||
    !proxy.port ||
    proxy.origin !== peer.url ||
    credentials.username !== 'dorkos' ||
    typeof credentials.password !== 'string' ||
    !credentials.password.length ||
    credentials.password.length > 4096 ||
    transport.onmessage ||
    transport.onclose
  )
    throw new Error('SUPERVISOR_AUTH_ORIGINAL_REFUSED');
  const authDiagnostic = createOriginalProxyAuthenticationDiagnostic();
  const sendOriginal = transport.send.bind(transport);
  const closeOriginal = transport.close.bind(transport);
  const failOriginal = failed;
  const pending = new Map<
    number,
    { resolve(): void; reject(value: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  const tasks = new Set<Promise<void>>();
  const attempts = new Set<string>();
  let first: Readonly<{ value: unknown }> | undefined;
  let stopping = false,
    cooperative = false,
    sequence = 0;
  let closing: Promise<void> | undefined, returned!: () => void;
  const closedOriginal = new Promise<void>((resolve) => {
    returned = resolve;
  });
  const note = (value: unknown) => {
    if (first) return;
    first = { value };
    try {
      failOriginal(value);
    } catch {
      /* Diagnostic callback cannot replace the original cause. */
    }
  };
  const task = (original: Promise<void>) => {
    tasks.add(original);
    void original.then(
      () => {
        tasks.delete(original);
      },
      (value) => {
        note(value);
        tasks.delete(original);
      }
    );
  };
  const send = (method: string, params: Message, sessionId: string): Promise<void> => {
    if (first || stopping || pending.size >= 128 || sequence >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(first ? first.value : new Error('SUPERVISOR_AUTH_ADMISSION_CLOSED'));
    const id = ++sequence;
    const original = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const cause = new Error('SUPERVISOR_AUTH_ACK_UNOBSERVED');
        note(cause);
        reject(cause);
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      try {
        sendOriginal({ id, method, params, sessionId });
      } catch (value) {
        pending.delete(id);
        clearTimeout(timer);
        note(value);
        reject(value);
      }
    });
    task(original);
    return original;
  };
  transport.onmessage = (value) => {
    try {
      if (!record(value)) throw new Error('SUPERVISOR_AUTH_MESSAGE_INVALID');
      if (typeof value.id === 'number') {
        const original = pending.get(value.id);
        if (!original) throw new Error('SUPERVISOR_AUTH_ACK_FOREIGN');
        pending.delete(value.id);
        clearTimeout(original.timer);
        if (Object.prototype.hasOwnProperty.call(value, 'error')) {
          note(value.error);
          original.reject(value.error);
        } else original.resolve();
        return;
      }
      if (!['Fetch.authRequired', 'Fetch.requestPaused'].includes(String(value.method))) return;
      if (stopping || first)
        throw first ? first.value : new Error('SUPERVISOR_AUTH_ADMISSION_CLOSED');
      if (
        !record(value.params) ||
        typeof value.params.requestId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        tasks.size >= 128
      )
        throw new Error('SUPERVISOR_AUTH_CHALLENGE_INVALID');
      const params = value.params,
        sessionId = value.sessionId;
      if (value.method === 'Fetch.requestPaused') {
        void send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
        return;
      }
      const challenge = record(params.authChallenge) ? params.authChallenge : undefined;
      const attempt = JSON.stringify([sessionId, params.requestId]);
      const firstAttempt = !attempts.has(attempt);
      if (attempts.size >= 4096) throw new Error('SUPERVISOR_AUTH_ATTEMPTS_EXHAUSTED');
      attempts.add(attempt);
      let exact = false;
      let proxySource: boolean | undefined, originMatch: boolean | undefined;
      if (
        firstAttempt &&
        (proxySource = challenge?.source === 'Proxy') &&
        typeof challenge!.origin === 'string'
      ) {
        try {
          exact = originMatch = new URL(challenge!.origin).origin === proxy.origin;
        } catch {
          /* Unknown challenge stays cancelled. */
        }
      }
      const authOriginal = send(
        'Fetch.continueWithAuth',
        {
          requestId: params.requestId,
          authChallengeResponse: exact
            ? { response: 'ProvideCredentials', ...credentials }
            : { response: 'CancelAuth' },
        },
        sessionId
      );
      authDiagnostic.emit(
        !firstAttempt
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
    } catch (value) {
      note(value);
    }
  };
  transport.onclose = (reason) => {
    if (!cooperative && !closing)
      note(reason === undefined ? new Error('SUPERVISOR_AUTH_UNEXPECTED_CLOSE') : reason);
    for (const original of pending.values()) {
      clearTimeout(original.timer);
      const cause = first ? first.value : new Error('SUPERVISOR_AUTH_ACK_UNOBSERVED');
      note(cause);
      original.reject(cause);
    }
    pending.clear();
    returned();
  };
  const owner = Object.freeze({
    isCustodyKnown: () => !first && !stopping,
    enterOriginalPeerClose() {
      if (first || pending.size || tasks.size)
        throw first ? first.value : new Error('SUPERVISOR_AUTH_ORIGINALS_PENDING');
      cooperative = true;
      stopping = true;
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      let resolve!: () => void, reject!: (reason: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Retain the original stop's returned work as well as its terminal callback. A
      // transport may return a promise even though the SDK's public close type is void.
      const stopOriginal = Promise.resolve().then(() => closeOriginal());
      void stopOriginal.catch(note);
      void (async () => {
        const outcomes = await Promise.allSettled([stopOriginal, closedOriginal]);
        for (const outcome of outcomes) if (outcome.status === 'rejected') note(outcome.reason);
        while (tasks.size) await Promise.allSettled([...tasks]);
        if (first) throw first.value;
        retained.delete(owner);
      })().then(resolve, reject);
      return closing;
    },
  });
  retained.add(owner);
  return owner;
}
