import type { ConnectOverCDPTransport } from 'playwright-core';
import { NativeIdentitySchema } from './native-observation.js';

type Message = Record<string, unknown>;
type Channel = 'authentication' | 'sdk';
type Target = {
  id: string;
  type: 'page' | 'iframe' | 'worker' | 'shared_worker' | 'service_worker';
  context?: string;
};
type Session = {
  target: Target;
  parent?: Session;
  identity: boolean;
  fetch: boolean;
  recursive: boolean;
  resume?: Message;
  resumed: boolean;
  retired: boolean;
};
type Pending = {
  session: Session;
  sessionId: string;
  internal: boolean;
  purpose: 'identity' | 'fetch' | 'recursive' | 'resume' | 'continue';
  timer: ReturnType<typeof setTimeout>;
};
const record = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const key = (target: Target) => JSON.stringify([target.context, target.id]);
const owned = new WeakSet<object>();

/** Supervisor-private identity bridge over two original wires. No runtime-mode or readiness mutation.
 * Its caller must be the genuine original launcher holding baseline, child and default context.
 * ACKs order this bridge only; actual first requests and first globals remain unverified.
 */
export function createSupervisorChromeBarrier(
  options: Readonly<{
    authentication: ConnectOverCDPTransport;
    sdk: ConnectOverCDPTransport;
    root: Readonly<{ id: string; context?: string }>;
    payload: Readonly<Message>;
    assertOriginalOwner(): void;
    /** Original cleanup custody after command admission has been revoked. */
    assertOriginalPeerCloseOwner?(): void;
    /** Private causal control: withhold one genuine first identity ACK, never synthesize it. */
    withholdFirstIdentityAcknowledgement?: true;
    /** Production original owned-proxy handler must be installed before the first autoattach. */
    authenticationRequired?: true;
  }>
) {
  const raws = { authentication: options.authentication, sdk: options.sdk };
  if (raws.authentication === raws.sdk) throw new Error('CHROME_FIXTURE_DISTINCT_WIRES_REQUIRED');
  for (const raw of Object.values(raws)) {
    if (owned.has(raw) || raw.onmessage || raw.onclose)
      throw new Error('CHROME_FIXTURE_WIRE_ALREADY_OWNED');
    owned.add(raw);
  }
  const sends = {
    authentication: raws.authentication.send.bind(raws.authentication),
    sdk: raws.sdk.send.bind(raws.sdk),
  };
  const closes = {
    authentication: raws.authentication.close.bind(raws.authentication),
    sdk: raws.sdk.close.bind(raws.sdk),
  };
  const opens = {
    authentication: raws.authentication.open?.bind(raws.authentication),
    sdk: raws.sdk.open?.bind(raws.sdk),
  };
  const assertOwner = options.assertOriginalOwner;
  const assertCloseOwner = options.assertOriginalPeerCloseOwner ?? assertOwner;
  const originalRoot = Object.freeze({ ...options.root });
  const payload = structuredClone(options.payload);
  const withholdIdentity = options.withholdFirstIdentityAcknowledgement === true;
  const authenticationRequired = options.authenticationRequired === true;
  let originalPeerClosing = false;
  let originalBrowserClose: Readonly<{ id: number; sessionId: string }> | undefined;
  let browserSessionAcquiring = false;
  let browserAttach: Readonly<{ id: number }> | undefined;
  let browserCloseSessionId: string | undefined;
  let identityAcknowledgementWithheld = false;
  const metadata = record(payload.userAgentMetadata) ? payload.userAgentMetadata : undefined;
  const { fullVersion, ...rest } = metadata ?? {};
  if (
    typeof payload.userAgent !== 'string' ||
    typeof payload.platform !== 'string' ||
    !metadata ||
    !NativeIdentitySchema.shape.metadata
      .unwrap()
      .required()
      .safeParse({ ...rest, uaFullVersion: fullVersion }).success
  )
    throw new Error('CHROME_FIXTURE_COMPLETE_TARGET_METADATA_REQUIRED');
  const sessions = {
    authentication: new Map<string, Session>(),
    sdk: new Map<string, Session>(),
  };
  const pending = {
    authentication: new Map<number, Pending>(),
    sdk: new Map<number, Pending>(),
  };
  const pairs = new Map<string, Partial<Record<Channel, Session>>>();
  const retired = new Set<string>();
  type SharedDetach = {
    original: Message;
    child: Session;
    parent?: Session;
    entered: boolean;
    replied: boolean;
    detached: boolean;
    timer: ReturnType<typeof setTimeout>;
  };
  const sharedDetaches = new Map<number, SharedDetach>();
  const detaching = new Map<Session, SharedDetach>();
  const releaseDetach = (original: SharedDetach) => {
    if (
      original.entered ||
      stopped ||
      !original.child.identity ||
      !authReady(pairs.get(key(original.child.target))?.authentication)
    )
      return;
    current('sdk', original.child);
    if (original.parent) current('sdk', original.parent);
    original.entered = true;
    sends.sdk(original.original);
  };
  const settleDetach = (original: SharedDetach) => {
    if (original.entered && original.replied && original.detached) clearTimeout(original.timer);
  };
  let stopped = false,
    failed = false,
    firstCause: unknown,
    nextPrivateId = -1000000;
  const closeDuties = new Map<Channel, Promise<unknown>>();
  let closeOriginal: Promise<void> | undefined;
  let authStart:
    | {
        id: number;
        resolve(): void;
        reject(error: unknown): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let authReadyOriginal: Promise<void> | undefined;
  const note = (cause: unknown) => {
    stopped = true;
    if (!failed) {
      failed = true;
      firstCause = cause;
    }
    if (authStart) {
      const original = authStart;
      authStart = undefined;
      clearTimeout(original.timer);
      original.reject(firstCause);
    }
  };
  const guard = () => {
    if (stopped) throw failed ? firstCause : new Error('CHROME_FIXTURE_ADMISSION_CLOSED');
    assertOwner();
    for (const channel of ['authentication', 'sdk'] as const)
      if (raws[channel].send !== originalSendMembers[channel])
        throw new Error('CHROME_FIXTURE_SEND_RECEIVER_REPLACED');
  };
  const originalSendMembers = {
    authentication: raws.authentication.send,
    sdk: raws.sdk.send,
  };
  const current = (channel: Channel, session: Session) => {
    guard();
    let value: Session | undefined = session,
      depth = 0;
    while (value) {
      if (
        ++depth > 32 ||
        value.retired ||
        retired.has(key(value.target)) ||
        ![...sessions[channel].values()].includes(value)
      )
        throw new Error('CHROME_FIXTURE_ORIGINAL_PARENT_RETIRED');
      value = value.parent;
    }
  };
  const authReady = (session: Session | undefined): boolean => {
    let currentSession = session,
      depth = 0;
    while (currentSession) {
      if (
        ++depth > 32 ||
        currentSession.retired ||
        !currentSession.identity ||
        !currentSession.recursive ||
        ![...sessions.authentication.values()].includes(currentSession)
      )
        return false;
      if (currentSession.target.type !== 'worker') return currentSession.fetch;
      currentSession = currentSession.parent;
    }
    return false;
  };
  const charge = (
    channel: Channel,
    id: number,
    sessionId: string,
    session: Session,
    purpose: Pending['purpose'],
    internal: boolean
  ) => {
    if (pending.authentication.size + pending.sdk.size >= 128 || pending[channel].has(id))
      throw new Error('CHROME_FIXTURE_REPLY_CAPACITY');
    const timer = setTimeout(() => note(new Error('CHROME_FIXTURE_ORIGINAL_ACK_UNKNOWN')), 5000);
    pending[channel].set(id, { sessionId, session, purpose, internal, timer });
  };
  const command = (
    channel: Channel,
    sessionId: string,
    session: Session,
    method: string,
    params: Message,
    purpose: Pending['purpose']
  ) => {
    current(channel, session);
    const id = nextPrivateId++;
    charge(channel, id, sessionId, session, purpose, true);
    sends[channel]({ id, sessionId, method, params });
  };
  const forward = (channel: Channel, session: Session) => {
    current(channel, session);
    const pair = pairs.get(key(session.target));
    if (
      !session.resume ||
      !session.identity ||
      !pair?.sdk?.identity ||
      !authReady(pair.authentication)
    )
      return;
    const original = session.resume;
    session.resume = undefined;
    session.resumed = true;
    charge(
      channel,
      original.id as number,
      original.sessionId as string,
      session,
      'resume',
      channel === 'authentication'
    );
    sends[channel](original);
  };
  const reconcile = (session: Session) => {
    const pair = pairs.get(key(session.target));
    if (pair?.authentication) forward('authentication', pair.authentication);
    if (pair?.sdk && !pair.sdk.retired) {
      forward('sdk', pair.sdk);
      const detach = detaching.get(pair.sdk);
      if (detach) releaseDetach(detach);
    }
  };
  const wrappers = {} as Record<Channel, ConnectOverCDPTransport>;
  for (const channel of ['authentication', 'sdk'] as const) {
    wrappers[channel] = {
      open() {
        guard();
        opens[channel]?.();
      },
      close() {
        return close();
      },
      send(value) {
        try {
          if (originalPeerClosing) {
            // Only the captured SDK browser session's single cooperative stop can cross
            // revoked admission. No target initialization, navigation or ordinary command.
            if (
              channel !== 'sdk' ||
              stopped ||
              failed ||
              originalBrowserClose ||
              !record(value) ||
              !Number.isSafeInteger(value.id) ||
              (value.id as number) < 1 ||
              value.method !== 'Browser.close' ||
              value.sessionId !== browserCloseSessionId ||
              typeof value.sessionId !== 'string' ||
              !value.sessionId ||
              !record(value.params) ||
              Object.keys(value.params).length
            )
              throw failed ? firstCause : new Error('SUPERVISOR_ORIGINAL_BROWSER_CLOSE_REFUSED');
            assertCloseOwner();
            if (raws.sdk.send !== originalSendMembers.sdk)
              throw new Error('CHROME_FIXTURE_SEND_RECEIVER_REPLACED');
            originalBrowserClose = Object.freeze({
              id: value.id as number,
              sessionId: value.sessionId,
            });
            sends.sdk(value);
            return;
          }
          guard();
          if (
            channel === 'sdk' &&
            browserSessionAcquiring &&
            record(value) &&
            value.method === 'Target.attachToBrowserTarget'
          ) {
            if (
              browserAttach ||
              value.sessionId !== undefined ||
              !record(value.params) ||
              Object.keys(value.params).length ||
              !Number.isSafeInteger(value.id) ||
              (value.id as number) < 1
            )
              throw new Error('SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REFUSED');
            browserAttach = Object.freeze({ id: value.id as number });
          }
          if (
            !record(value) ||
            !Number.isSafeInteger(value.id) ||
            (value.id as number) < 1 ||
            typeof value.method !== 'string'
          )
            throw new Error('CHROME_FIXTURE_SDK_COMMAND_INVALID');
          const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
          const session = sessionId ? sessions[channel].get(sessionId) : undefined;
          if (value.method === 'Runtime.runIfWaitingForDebugger') {
            if (
              !session ||
              session.resume ||
              session.resumed ||
              !record(value.params) ||
              Object.keys(value.params).length
            )
              throw new Error('CHROME_FIXTURE_ORIGINAL_RESUME_REFUSED');
            session.resume = Object.freeze({
              ...value,
              params: Object.freeze({}),
            });
            forward(channel, session);
            return;
          }
          if (session) current(channel, session);
          if (
            ['Emulation.setUserAgentOverride', 'Network.setUserAgentOverride'].includes(
              value.method
            )
          ) {
            if (!session || !sessionId || session.resumed)
              throw new Error('CHROME_FIXTURE_LATE_METADATA_REFUSED');
            session.identity = false;
            charge(channel, value.id as number, sessionId, session, 'identity', false);
            sends[channel]({ ...value, params: structuredClone(payload) });
            return;
          }
          // Retain the exact SDK shared detach until the independent auth original is configured.
          if (
            channel === 'sdk' &&
            value.method === 'Target.detachFromTarget' &&
            record(value.params) &&
            typeof value.params.sessionId === 'string'
          ) {
            const child = sessions.sdk.get(value.params.sessionId);
            if (child?.target.type === 'shared_worker') {
              if (
                detaching.has(child) ||
                sharedDetaches.size >= 64 ||
                sharedDetaches.has(value.id as number) ||
                (session && child.parent !== session) ||
                (!session && child.parent) ||
                child.resume ||
                child.resumed
              )
                throw new Error('CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_REFUSED');
              const original: SharedDetach = {
                original: Object.freeze({
                  ...value,
                  params: Object.freeze({ ...value.params }),
                }),
                child,
                parent: session,
                entered: false,
                replied: false,
                detached: false,
                timer: setTimeout(
                  () => note(new Error('CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_UNKNOWN')),
                  5000
                ),
              };
              sharedDetaches.set(value.id as number, original);
              detaching.set(child, original);
              releaseDetach(original);
              return;
            }
          }
          sends[channel](value);
        } catch (cause) {
          note(cause);
          throw cause;
        }
      },
    };
    raws[channel].onmessage = (value) => {
      try {
        if (!record(value)) throw new Error('CHROME_FIXTURE_ORIGINAL_MESSAGE_INVALID');
        if (channel === 'sdk' && browserAttach && value.id === browserAttach.id) {
          if (browserCloseSessionId !== undefined)
            throw new Error('SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REPLY_REPEATED');
          if (
            value.sessionId !== undefined ||
            Object.prototype.hasOwnProperty.call(value, 'error') ||
            !record(value.result) ||
            typeof value.result.sessionId !== 'string' ||
            !value.result.sessionId
          ) {
            note(
              Object.prototype.hasOwnProperty.call(value, 'error')
                ? value.error
                : new Error('SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REPLY_REFUSED')
            );
          } else browserCloseSessionId = value.result.sessionId;
          // Deliver the exact held acquisition response even after admission revocation.
          // It returns an original session for captured detach; post-acquisition admission
          // still refuses the owner. Dropping this response would strand the genuine SDK.
          wrappers.sdk.onmessage?.(value);
          return;
        }
        if (originalPeerClosing) {
          // No admission-dependent target machinery during original shutdown. Only its
          // retained exact response is delivered; raw wire closure still reaches the SDK.
          if (channel === 'sdk' && originalBrowserClose && value.id === originalBrowserClose.id) {
            if (value.sessionId !== originalBrowserClose.sessionId)
              throw new Error('SUPERVISOR_ORIGINAL_BROWSER_CLOSE_REPLY_CHANGED');
            if (Object.prototype.hasOwnProperty.call(value, 'error')) note(value.error);
            wrappers.sdk.onmessage?.(value);
          }
          return;
        }
        if (channel === 'sdk' && typeof value.id === 'number' && sharedDetaches.has(value.id)) {
          const original = sharedDetaches.get(value.id)!;
          if (
            !original.entered ||
            original.replied ||
            value.sessionId !== original.original.sessionId ||
            value.error !== undefined ||
            !record(value.result)
          )
            throw value.error !== undefined
              ? value.error
              : new Error('CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_ACK_INVALID');
          original.replied = true;
          settleDetach(original);
        }
        if (channel === 'authentication' && authStart && value.id === authStart.id) {
          const original = authStart;
          const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
          const error = hasError ? value.error : undefined;
          const result = hasError ? undefined : value.result;
          const sessionId = value.sessionId;
          authStart = undefined;
          clearTimeout(original.timer);
          if (sessionId !== undefined || hasError || !record(result)) {
            const cause = hasError ? error : new Error('CHROME_FIXTURE_AUTH_ROOT_ACK_INVALID');
            note(cause);
            original.reject(firstCause);
          } else original.resolve();
          return;
        }
        if (typeof value.id === 'number' && pending[channel].has(value.id)) {
          const owner = pending[channel].get(value.id)!;
          if (value.sessionId !== owner.sessionId)
            throw new Error('CHROME_FIXTURE_ORIGINAL_REPLY_CHANGED');
          if (
            withholdIdentity &&
            !identityAcknowledgementWithheld &&
            owner.purpose === 'identity'
          ) {
            identityAcknowledgementWithheld = true;
            return; // Original pending duty/timeout remains owned.
          }
          pending[channel].delete(value.id);
          clearTimeout(owner.timer);
          if (value.error !== undefined || !record(value.result)) {
            note(
              value.error !== undefined
                ? value.error
                : new Error('CHROME_FIXTURE_ORIGINAL_ACK_INVALID')
            );
            return;
          }
          if (!stopped) {
            current(channel, owner.session);
            if (owner.purpose !== 'resume' && owner.purpose !== 'continue')
              owner.session[owner.purpose] = true;
            reconcile(owner.session);
          }
          if (owner.internal || stopped) return;
        }
        if (stopped) return;
        guard();
        if (value.method === 'Target.attachedToTarget') {
          if (
            !record(value.params) ||
            !record(value.params.targetInfo) ||
            typeof value.params.sessionId !== 'string'
          )
            throw new Error('CHROME_FIXTURE_ORIGINAL_ATTACHMENT_INVALID');
          const info = value.params.targetInfo;
          if (
            typeof info.targetId !== 'string' ||
            !info.targetId ||
            info.targetId.length > 256 ||
            !['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(
              String(info.type)
            )
          )
            throw new Error('CHROME_FIXTURE_TARGET_UNSUPPORTED');
          const parent =
            typeof value.sessionId === 'string'
              ? sessions[channel].get(value.sessionId)
              : undefined;
          if (parent) current(channel, parent);
          const needsParent = info.type === 'worker' || info.type === 'iframe';
          const context = needsParent
            ? (info.browserContextId ?? parent?.target.context)
            : info.browserContextId;
          if (context !== originalRoot.context || (needsParent && !parent))
            throw new Error('CHROME_FIXTURE_CONTEXT_CHANGED');
          if (
            info.targetId === originalRoot.id
              ? info.url !== 'about:blank'
              : value.params.waitingForDebugger !== true
          )
            throw new Error('CHROME_FIXTURE_MISSED_FIRST_INITIALIZATION');
          if (
            info.type === 'page' &&
            info.targetId !== originalRoot.id &&
            (typeof info.openerId !== 'string' ||
              ![...sessions[channel].values()].some(
                (s) => s.target.id === info.openerId && !s.retired
              ))
          )
            throw new Error('CHROME_FIXTURE_POPUP_OPENER_UNKNOWN');
          const target: Target = {
            id: info.targetId,
            type: info.type as Target['type'],
            context: context as string | undefined,
          };
          const targetKey = key(target),
            pair = pairs.get(targetKey) ?? {};
          if (
            sessions[channel].size >= 64 ||
            sessions[channel].has(value.params.sessionId) ||
            pair[channel] ||
            retired.has(targetKey)
          )
            throw new Error('CHROME_FIXTURE_ORIGINAL_TARGET_REPLACED');
          const session: Session = {
            target,
            parent: needsParent ? parent : undefined,
            identity: false,
            fetch: false,
            recursive: false,
            resumed: false,
            retired: false,
          };
          sessions[channel].set(value.params.sessionId, session);
          pair[channel] = session;
          pairs.set(targetKey, pair);
          // Register the original session before synchronous original replies can arrive.
          command(
            channel,
            value.params.sessionId,
            session,
            'Emulation.setUserAgentOverride',
            structuredClone(payload),
            'identity'
          );
          if (channel === 'authentication') {
            if (target.type !== 'worker')
              command(
                channel,
                value.params.sessionId,
                session,
                'Fetch.enable',
                { handleAuthRequests: true },
                'fetch'
              );
            command(
              channel,
              value.params.sessionId,
              session,
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
              'recursive'
            );
            const id = nextPrivateId++;
            session.resume = {
              id,
              sessionId: value.params.sessionId,
              method: 'Runtime.runIfWaitingForDebugger',
              params: {},
            };
            forward(channel, session);
          }
        } else if (
          value.method === 'Target.detachedFromTarget' &&
          record(value.params) &&
          typeof value.params.sessionId === 'string'
        ) {
          const original = sessions[channel].get(value.params.sessionId);
          if (original && channel === 'sdk' && detaching.has(original)) {
            const detach = detaching.get(original)!;
            if (
              !detach.entered ||
              detach.detached ||
              value.sessionId !== detach.original.sessionId ||
              (value.params.targetId !== undefined && value.params.targetId !== original.target.id)
            )
              throw new Error('CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_EVENT_INVALID');
            detach.detached = true;
            original.retired = true;
            settleDetach(detach);
            wrappers.sdk.onmessage?.(value);
            return;
          }
          if (original) {
            original.retired = true;
            retired.add(key(original.target));
            if (
              !original.resumed ||
              [...pending[channel].values()].some((owner) => owner.session === original)
            )
              note(new Error('CHROME_FIXTURE_ORIGINAL_TARGET_RETURN_UNKNOWN'));
          }
        } else if (
          channel === 'authentication' &&
          ['Fetch.authRequired', 'Fetch.requestPaused'].includes(String(value.method))
        ) {
          // Target/session validation is common; production delegates the original challenge
          // to its already attached owned-proxy listener instead of cancelling it twice.
          if (
            !record(value.params) ||
            typeof value.params.requestId !== 'string' ||
            typeof value.sessionId !== 'string'
          )
            throw new Error('CHROME_FIXTURE_FETCH_EVENT_INVALID');
          const originalSession = sessions.authentication.get(value.sessionId);
          if (!originalSession) throw new Error('CHROME_FIXTURE_FETCH_OWNER_UNKNOWN');
          if (authenticationRequired) {
            if (
              !authReady(originalSession) ||
              !pairs.get(key(originalSession.target))?.sdk?.identity
            )
              throw new Error('SUPERVISOR_AUTH_TARGET_IDENTITY_UNOBSERVED');
            const originalHandler = wrappers.authentication.onmessage;
            if (!originalHandler) throw new Error('SUPERVISOR_AUTH_HANDLER_UNAVAILABLE');
            originalHandler(value);
            return;
          }
          command(
            'authentication',
            value.sessionId,
            originalSession,
            value.method === 'Fetch.authRequired'
              ? 'Fetch.continueWithAuth'
              : 'Fetch.continueRequest',
            value.method === 'Fetch.authRequired'
              ? {
                  requestId: value.params.requestId,
                  authChallengeResponse: { response: 'CancelAuth' },
                }
              : { requestId: value.params.requestId },
            'continue'
          );
        }
        if (!stopped) wrappers[channel].onmessage?.(value);
      } catch (cause) {
        note(cause);
      }
    };
    raws[channel].onclose = (reason) => {
      if (!closeOriginal && !originalPeerClosing)
        note(new Error('CHROME_FIXTURE_ORIGINAL_WIRE_CLOSED'));
      wrappers[channel].onclose?.(reason);
    };
  }
  async function close(): Promise<void> {
    if (closeOriginal) return closeOriginal;
    stopped = true;
    if (authStart) note(new Error('CHROME_FIXTURE_ADMISSION_CLOSED'));
    closeOriginal = (async () => {
      for (const channel of ['authentication', 'sdk'] as const) {
        const original = Promise.resolve().then(() => closes[channel]());
        closeDuties.set(channel, original);
        void original.catch(note);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...closeDuties.values()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('CHROME_FIXTURE_ORIGINAL_CLOSE_UNKNOWN')),
              2000
            );
          }),
        ]);
      } catch (cause) {
        note(cause);
      } finally {
        if (timer) clearTimeout(timer);
      }
      for (const original of sharedDetaches.values()) clearTimeout(original.timer);
      if (authStart) clearTimeout(authStart.timer);
      for (const entries of Object.values(pending))
        for (const owner of entries.values()) clearTimeout(owner.timer);
      if (
        failed ||
        authStart ||
        pending.authentication.size ||
        pending.sdk.size ||
        [...sharedDetaches.values()].some(
          (original) => !original.entered || !original.replied || !original.detached
        )
      )
        throw failed ? firstCause : new Error('CHROME_FIXTURE_ORIGINAL_CLOSE_UNKNOWN');
    })();
    void closeOriginal.catch(note);
    return closeOriginal;
  }
  return Object.freeze({
    authentication: wrappers.authentication,
    sdk: wrappers.sdk,
    close,
    async acquireOriginalBrowserCloseSession<T>(producer: () => Promise<T>): Promise<T> {
      guard();
      if (browserSessionAcquiring || browserAttach || browserCloseSessionId)
        throw new Error('SUPERVISOR_ORIGINAL_BROWSER_SESSION_REUSED');
      browserSessionAcquiring = true; // Reserve correlation before any original SDK reentry.
      try {
        const result = await producer();
        if (!browserAttach || !browserCloseSessionId)
          throw new Error('SUPERVISOR_ORIGINAL_BROWSER_SESSION_UNOBSERVED');
        return result;
      } finally {
        browserSessionAcquiring = false;
      }
    },
    enterOriginalPeerClose() {
      if (stopped || originalPeerClosing)
        throw failed ? firstCause : new Error('CHROME_FIXTURE_ADMISSION_CLOSED');
      assertCloseOwner();
      for (const channel of ['authentication', 'sdk'] as const)
        if (raws[channel].send !== originalSendMembers[channel])
          throw new Error('CHROME_FIXTURE_SEND_RECEIVER_REPLACED');
      if (authStart || pending.authentication.size || pending.sdk.size)
        throw new Error('SUPERVISOR_IDENTITY_ORIGINALS_PENDING');
      originalPeerClosing = true;
    },
    startAuthentication() {
      if (authReadyOriginal) return authReadyOriginal;
      if (authenticationRequired && !wrappers.authentication.onmessage)
        throw new Error('SUPERVISOR_AUTH_HANDLER_UNAVAILABLE');
      const id = nextPrivateId++;
      let resolve!: () => void, reject!: (value: unknown) => void;
      authReadyOriginal = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void authReadyOriginal.catch(note);
      const timer = setTimeout(() => note(new Error('CHROME_FIXTURE_AUTH_ROOT_ACK_UNKNOWN')), 5000);
      authStart = { id, resolve, reject, timer }; // Reserve exact bank before original send/reentry.
      try {
        guard();
        sends.authentication({
          id,
          method: 'Target.setAutoAttach',
          params: {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}],
          },
        });
      } catch (cause) {
        note(cause);
      }
      return authReadyOriginal;
    },
    status: () => ({
      unavailable: stopped,
      failed,
      firstCause,
      targets: pairs.size,
      pending: pending.authentication.size + pending.sdk.size,
      closeDuties: closeDuties.size,
      identityAcknowledgementWithheld,
    }),
  });
}
