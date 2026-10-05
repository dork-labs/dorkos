import { verifyPeer } from './transport.js';
import type { EgressPolicyOptions } from '../settings.js';
import { custodyPolicy } from './policy-custody.js';
import type { BrokerIssuer, RunHandle, Permit, PreparedRunReceiver } from './issuer.js';
import type { BrokerTransport, OwnedListener, OwnedSocket, AcceptedRequest } from './transport.js';
import { validateUpgrade, renderResponse } from './responses.js';
import { BrokerError } from './errors.js';
import { bounded } from './clock.js';
import { parseDestination } from '../destination.js';
import { frameRequest, validateProxyChallenge } from './framing.js';
import { brokerCredential } from './credential.js';
import { brokerLocalGrants } from './local-grants.js';
import { createIntake } from './intake.js';
import { forwardFlow, guardedWrite, guardedCall } from './flow.js';
import { forwardDuplex } from './duplex.js';
import type { Charge } from './ledger.js';
/** Complete dormant private fixture broker; absent live authority refuses before listen. */
export function createPrivateBroker(options: {
  issuer: BrokerIssuer;
  run: RunHandle;
  policy: EgressPolicyOptions;
  transport: BrokerTransport;
  preparedReceiver?: PreparedRunReceiver;
}) {
  const { issuer, run, transport } = options;
  const receiver = options.preparedReceiver;
  let activated = receiver === undefined;
  let policyPort = custodyPolicy({ ...options.policy, now: issuer.now });
  if (receiver) issuer.checkPrepared(run, receiver);
  else issuer.check(run);
  if (options.policy.revision !== issuer.snapshot(run).policyRevision)
    throw new BrokerError('AUTHORITY_REFUSED');
  if (
    transport.scope !== 'fixture-only' ||
    (transport.intake !== undefined && transport.intake !== 'listener-owned')
  )
    throw new BrokerError('UNAVAILABLE');
  const credential = brokerCredential();
  const closeLocal = () => intake.closeLocal();
  let local = brokerLocalGrants(issuer, run, policyPort.policy, closeLocal);
  let stopped = false;
  let listener: OwnedListener | undefined;
  let startup: Promise<{ server: string; listener: OwnedListener }> | undefined;
  let closing: Promise<boolean> | undefined;
  let listenerClosed = false;
  let listenerSettled = false;
  const listenerCharge: Charge = issuer.ledger.reserve('listener');
  const listenerWaiters = new Set<() => void>();
  const listenerObserved = () => {
    for (const done of listenerWaiters) done();
    listenerWaiters.clear();
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const check = () => {
    if (stopped) throw new BrokerError('CLOSED');
    const state = issuer.check(run);
    intake.checkLocal(() => local.check(state.inventory));
    if (stopped) throw new BrokerError('CLOSED');
    return state;
  };
  const checkAdmission = () => {
    if (stopped) throw new BrokerError('CLOSED');
    if (receiver && !activated) return issuer.checkPrepared(run, receiver);
    return check();
  };
  const schedule = (ms: number, action: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const intake = createIntake({
    issuer,
    run,
    check: checkAdmission,
    isStopped: () => stopped,
    timers,
    schedule,
  });
  const clients = intake.clients;
  const dispatch = async (request: AcceptedRequest) => {
    const record = clients.get(request.client.identity);
    if (!record) return;
    if (record.started) {
      void record.close();
      return;
    }
    record.started = true;
    const settle = record.custody.pending();
    let completed = false;
    const done = () => {
      if (!completed) {
        completed = true;
        settle();
      }
    };
    const abort = new AbortController();
    let socket: OwnedSocket | undefined;
    const flows: ReturnType<typeof forwardFlow>[] = [];
    const close = () => {
      try {
        abort.abort();
      } catch {
        // Continue exact endpoint cleanup even if a cancellation callback fails.
      }
      for (const flow of flows) {
        try {
          flow.stop();
        } catch {
          // One detachment failure must not suppress other owned cleanup.
        }
      }
      return record.custody.close();
    };
    record.close = close;
    const ownedSchedule = (ms: number, action: () => void) => {
      const timer = schedule(ms, () => {
        record.timers.delete(timer);
        action();
      });
      record.timers.add(timer);
      return timer;
    };
    try {
      guardedCall(request.body, 'pause', check);
      guardedCall(request.client, 'pause', check);
      if (
        !request.raw.rawHeaders.some(
          (name, index) => index % 2 === 0 && name.toLowerCase() === 'proxy-authorization'
        )
      ) {
        validateProxyChallenge(request.raw, issuer.limits);
        issuer.ledger.transfer(record.charge, run);
        await issuer.current(run);
        check();
        ownedSchedule(issuer.limits.headerMs, () => {
          void close();
        });
        guardedWrite(
          request.client,
          Buffer.from(
            'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="DorkOS"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
          ),
          check,
          issuer.limits.queueBytes
        );
        guardedCall(request.client, 'end', check);
        return;
      }
      const framed = frameRequest(request.raw, issuer.limits);
      if (!credential.verify(framed.credential, issuer.limits.credentialBytes))
        throw new BrokerError('CREDENTIAL_REFUSED');
      if (
        request.raw.head.byteLength > issuer.limits.queueBytes ||
        request.raw.head.byteLength > issuer.limits.duplexBytes
      )
        throw new BrokerError('BYTE_LIMIT');
      issuer.ledger.transfer(record.charge, run);
      await issuer.current(run);
      check();
      const grant = local.get(
        framed.url,
        framed.kind === 'websocket'
          ? 'websocket'
          : framed.kind === 'opaque-connect'
            ? 'opaque-connect'
            : 'http'
      );
      record.local = grant !== undefined;
      const decision = await policyPort.authorize(record.custody, {
        url: framed.url,
        hostHeader: framed.destination.authority,
        context: issuer.snapshot(run).binding,
        grant,
        signal: abort.signal,
      });
      const fence = () => {
        check();
        if (record.local) local.check(issuer.snapshot(run).inventoryRevision);
        const i = issuer.inventory(),
          current = issuer.now(),
          state = issuer.snapshot(run);
        if (
          stopped ||
          state.state !== 'active' ||
          record.custody.stopped() ||
          state.policyRevision !== decision.revision ||
          state.inventoryRevision !== i.revision ||
          (record.local && !i.localCoverageComplete) ||
          current >= state.deadline ||
          (decision.expiresAt !== undefined && current >= decision.expiresAt)
        )
          throw new BrokerError('AUTHORITY_REFUSED');
      };
      fence();
      const selected = decision.endpoints[0];
      if (!selected) throw new BrokerError('PEER_REFUSED');
      const dialDone = record.custody.pending();
      const discover = issuer.ledger.socket(record.charge, {});
      let dialRegistered = false;
      const dial = Promise.resolve().then(() => {
        const dial = transport.dial;
        fence();
        return Reflect.apply(dial, transport, [
          selected,
          {
            signal: abort.signal,
            autoSelectFamily: false,
            onSocket: (s) => {
              record.custody.track(s);
              dialRegistered = true;
              try {
                fence();
                return true;
              } catch {
                void record.close();
                return false;
              }
            },
            lookup: () => {
              throw new BrokerError('PEER_REFUSED');
            },
          },
        ]) as ReturnType<typeof dial>;
      });
      dial.then(
        (observed) => {
          try {
            record.custody.track(observed.socket);
            dialRegistered = true;
            discover();
          } catch {
            void record.close();
            try {
              observed.socket.destroy();
            } catch {
              /* Unknown socket retains its charge. */
            }
          } finally {
            dialDone();
          }
        },
        () => {
          if (dialRegistered) discover();
          dialDone();
        }
      );
      const connected = await bounded(dial, issuer.limits.dialMs);
      socket = connected.socket;
      if (connected.outcome !== 'connected') throw new BrokerError('PEER_REFUSED');
      fence();
      verifyPeer(socket, selected);
      fence();
      const expire = () => {
        try {
          fence();
          ownedSchedule(
            Math.min(1000, Math.max(1, issuer.snapshot(run).deadline - issuer.now())),
            expire
          );
        } catch {
          void close();
        }
      };
      expire();
      if (decision.expiresAt !== undefined)
        ownedSchedule(Math.max(1, decision.expiresAt - issuer.now()), () => {
          void close();
        });
      const failure = () => {
        void close();
      };
      if (framed.kind === 'http') ownedSchedule(issuer.limits.operationMs, failure);
      if (framed.kind === 'opaque-connect') {
        forwardDuplex({
          client: request.client,
          origin: socket,
          head: request.raw.head,
          responseHead: Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'),
          fence,
          failure,
          flows,
          issuer,
          schedule: ownedSchedule,
          cancel: (timer) => {
            timers.delete(timer);
            clearTimeout(timer);
          },
        });
      } else {
        const exchange = transport.exchange;
        fence();
        const response = await bounded(
          Reflect.apply(exchange, transport, [
            socket,
            framed,
            request.body,
            {
              check: fence,
              bodyLimit: issuer.limits.bodyBytes,
              queueLimit: issuer.limits.queueBytes,
            },
          ]) as ReturnType<typeof exchange>,
          issuer.limits.operationMs
        );
        fence();
        if (framed.kind === 'websocket') {
          validateUpgrade(response, framed.websocketKey!);
          if (response.head.byteLength > issuer.limits.headBytes)
            throw new BrokerError('BYTE_LIMIT');
          forwardDuplex({
            client: request.client,
            origin: socket,
            head: request.raw.head,
            responseHead: Buffer.concat([
              renderResponse(response, true, issuer.limits),
              response.head,
            ]),
            fence,
            failure,
            flows,
            issuer,
            schedule: ownedSchedule,
            cancel: (timer) => {
              timers.delete(timer);
              clearTimeout(timer);
            },
          });
        } else {
          if (response.status === 101) throw new BrokerError('UPGRADE_REFUSED');
          const header = renderResponse(response, false, issuer.limits);
          const headerBlocked = !guardedWrite(
            request.client,
            header,
            fence,
            issuer.limits.queueBytes
          );
          flows.push(
            forwardFlow({
              source: response.body,
              target: request.client,
              check: fence,
              limit: issuer.limits.bodyBytes,
              queueLimit: issuer.limits.queueBytes,
              onFailure: failure,
              initiallyBlocked: headerBlocked,
              endOnSourceEOF: true,
              resumeOnStart: true,
            })
          );
        }
      }
    } catch {
      done();
      await close();
    } finally {
      done();
      if (record.custody.stopped()) void record.custody.close();
    }
  };
  let listenerDiscovery: (() => void) | undefined;
  const registerListener = (l: OwnedListener) => {
    if (listener?.identity === l.identity) return !stopped;
    if (listener) throw new BrokerError('CLEANUP_UNVERIFIED');
    listener = l;
    const observe = issuer.ledger.socket(listenerCharge!, l.identity);
    l.onClose(() => {
      listenerClosed = true;
      observe();
      listenerObserved();
      if (listenerCharge) issuer.ledger.release(listenerCharge);
    });
    if (stopped) {
      try {
        l.close();
      } catch {
        /* Keep exact late listener custody. */
      }
    }
    return !stopped;
  };
  const close = (): Promise<boolean> => {
    if (closing) return closing;
    stopped = true;
    let resolve!: (value: boolean) => void;
    closing = new Promise<boolean>((done) => {
      resolve = done;
    });
    issuer.revoke(run);
    local.revoke();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const pending = [...intake.prepared.values()].map((record) => record.close());
    if (!startup) {
      listenerSettled = true;
      listenerClosed = true;
      issuer.ledger.release(listenerCharge);
    }
    if (!listenerClosed)
      pending.push(new Promise<boolean>((done) => listenerWaiters.add(() => done(true))));
    if (listener) {
      try {
        listener.close();
      } catch {
        /* Retain listener charge. */
      }
    }
    bounded(Promise.all(pending), issuer.limits.cleanupMs).then(
      (results) => {
        const observed =
          results.every(Boolean) && (!listenerCharge || (listenerSettled && listenerClosed));
        if (observed) {
          unsubscribe();
          const released = issuer.releaseRun(run);
          if (receiver && !released) {
            resolve(false);
            return;
          }
        }
        resolve(observed);
      },
      () => resolve(false)
    );
    return closing;
  };
  const unsubscribe = issuer.onInvalidation(run, (state) => {
    if (state === 'terminal') {
      void close();
      return;
    }
    local.revoke();
    for (const record of intake.prepared.values()) void record.close();
  });
  let activation: Promise<void> | undefined;
  let preparationTimer: ReturnType<typeof setTimeout> | undefined;
  const expirePrepared = () => {
    if (!receiver || activated || stopped) return;
    try {
      issuer.checkPrepared(run, receiver);
      preparationTimer = schedule(
        Math.max(1, issuer.snapshot(run).deadline - issuer.now()),
        expirePrepared
      );
    } catch {
      void close();
    }
  };
  if (receiver)
    preparationTimer = schedule(
      Math.max(1, issuer.snapshot(run).deadline - issuer.now()),
      expirePrepared
    );
  return Object.freeze({
    start() {
      if (startup) return Promise.reject(new BrokerError('CLOSED'));
      checkAdmission(); // Authority observations may synchronously start this exact owner.
      if (startup) return Promise.reject(new BrokerError('CLOSED'));
      const settled = issuer.ledger.pending(listenerCharge);
      listenerDiscovery = issuer.ledger.socket(listenerCharge, {});
      const task = Promise.resolve().then(() => {
        const listen = transport.listen;
        checkAdmission();
        return Reflect.apply(listen, transport, [
          {
            maxConnections: issuer.limits.unauthenticated,
            headerBytes: issuer.limits.headerBytes,
            headerMs: issuer.limits.headerMs,
            reserveSocket: intake.reserve,
            onSocket: (slot, socket) => {
              const admitted = intake.register(slot, socket);
              if (admitted && receiver && !activated) {
                // No cold connection can become a ready request later. Its exact
                // original remains charged until the real close receipt arrives.
                const record = clients.get(socket.identity)!;
                record.started = true;
                void record.close();
              }
              return admitted;
            },
            onListener: registerListener,
            onRequest: (r) => {
              void dispatch(r);
            },
            onPipeline: (s) => {
              void clients.get(s.identity)?.close();
            },
          },
        ]) as ReturnType<typeof listen>;
      });
      task.then(
        (l) => {
          listenerSettled = true;
          settled();
          try {
            registerListener(l);
            listenerDiscovery?.();
          } catch {
            void close();
          }
          if (listenerClosed && listenerCharge) issuer.ledger.release(listenerCharge);
          if (stopped) {
            try {
              l.close();
            } catch {
              /* Late ownership retained. */
            }
          }
        },
        () => {
          listenerSettled = true;
          settled();
          if (listener) {
            listenerDiscovery?.();
            if (stopped) {
              try {
                listener.close();
              } catch {
                /* Retain actual failed-acquisition custody. */
              }
            }
          }
        }
      );
      startup = bounded(task, issuer.limits.dialMs).then((l) => {
        const address = l.address,
          port = l.port;
        checkAdmission();
        const invalidPort = !Number.isInteger(port) || port < 1 || port > 65535;
        if (listenerClosed || listener !== l || address !== '127.0.0.1' || invalidPort)
          throw new BrokerError('UNAVAILABLE');
        return { server: `http://127.0.0.1:${port}`, listener: l };
      });
      return startup
        .then(({ server, listener: ready }) => {
          checkAdmission();
          if (listenerClosed || listener !== ready) throw new BrokerError('UNAVAILABLE');
          const secret = credential.take();
          return Object.freeze({
            server,
            credential: secret,
            credentials: Object.freeze({ username: 'dorkos', password: secret }),
          });
        })
        .catch(async () => {
          await close();
          throw new BrokerError('UNAVAILABLE');
        });
    },
    activate(originalReceiver: PreparedRunReceiver) {
      if (
        !receiver ||
        receiver !== originalReceiver ||
        activation ||
        !startup ||
        !listenerSettled ||
        listenerClosed ||
        stopped ||
        [...intake.prepared.values()].some((record) => !record.custody.isCustodyKnown())
      ) {
        if (receiver && !activated) void close();
        return Promise.reject(new BrokerError('CLOSED'));
      }
      activation = issuer
        .activatePrepared(run, originalReceiver, (policyOptions) => {
          const next = custodyPolicy({ ...policyOptions, now: issuer.now });
          const grants = brokerLocalGrants(issuer, run, next.policy, closeLocal);
          policyPort = next;
          local = grants;
        })
        .then(() => {
          activated = true;
          check();
          if (preparationTimer) {
            clearTimeout(preparationTimer);
            timers.delete(preparationTimer);
            preparationTimer = undefined;
          }
        })
        .catch(async (error) => {
          await close();
          throw error;
        });
      return activation;
    },
    grantLocal(...args: Parameters<typeof local.issue>) {
      const target = parseDestination({ url: args[0] });
      if (
        !listener ||
        listenerClosed ||
        (target.hostname === listener.address && target.port === listener.port)
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      return local.issue(...args);
    },
    revokeLocal() {
      local.revoke();
      for (const c of clients.values()) void c.close();
    },
    suspend() {
      issuer.suspend(run);
    },
    rebind(policyOptions: EgressPolicyOptions, sequence: number, permit: Permit) {
      if (stopped || intake.prepared.size) throw new BrokerError('CLOSED');
      const next = custodyPolicy({ ...policyOptions, now: issuer.now });
      const grants = brokerLocalGrants(issuer, run, next.policy, closeLocal);
      issuer.consumeRevision(run, sequence, permit, policyOptions.revision);
      policyPort = next;
      local = grants;
    },
    close,
    /** Private original-owner handoff for protected inventory; never a caller endpoint DTO. */
    ownedListener() {
      return listener;
    },
    isCustodyKnown() {
      return (
        !stopped &&
        listenerSettled &&
        listener !== undefined &&
        !listenerClosed &&
        listener.isCustodyKnown?.() === true &&
        [...intake.prepared.values()].every((record) => record.custody.isCustodyKnown())
      );
    },
    status() {
      return Object.freeze({
        stopped,
        activated,
        listenerSettled,
        listenerClosed,
        clients: clients.size,
        prepared: intake.prepared.size,
        ledger: issuer.ledger.snapshot(),
      });
    },
  });
}

/** Prelaunch capacity and exact original intake, never a prepared forwarding authority. */
export function createPreparedPrivateBroker(
  options: Omit<Parameters<typeof createPrivateBroker>[0], 'preparedReceiver'> & {
    receiver: PreparedRunReceiver;
  }
) {
  return createPrivateBroker({ ...options, preparedReceiver: options.receiver });
}
