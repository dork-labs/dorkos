import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { BrowserRuntimeDescriptor } from '../../../../../../../../packages/browser/src/runtime-descriptor.js';
import type { ProcessIdentity } from '../../../../../../../../packages/browser/src/configuration.js';
import {
  ownDirectory,
  assertDirectory,
} from '../../../../../../../../packages/browser/src/profiles/owned-directory.js';
import { startDarwinSupervisorClient } from '../../../../../../../../packages/browser/src/runtime/darwin-supervisor-client.js';
import { createDarwinEngineProcesses } from '../../../../../../../../packages/browser/src/runtime/darwin-engine-processes.js';
import { createSupervisorProtocolWire } from '../../../../../../../../packages/browser/src/runtime/identity/supervisor-protocol-wire.js';
import { readControllerOriginalCatalog } from '../../../../../../../../packages/browser/src/runtime/identity/controller-original-catalog.js';
import { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';
import { verifiedLibrary } from '../../../../../../../../packages/browser/src/runtime/public-library.js';
import type { verifyInstalledNativeJournal } from '@dorkos/browser/runtime-installation';
import { createProductionDestinationResolver } from '../../node-resolver.js';
import { createBrokerIssuer } from '../issuer.js';
import { createPreparedPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node/node-transport.js';
import type { OriginalConnectDenial } from '../connect-denial.js';
import type { OwnedSocket } from '../transport.js';
// The peer-authenticated preflight constructor owns both tunnels and HTTP origins.
import { readOriginalQuickTunnelPort } from './quick-tunnel-preflight.fixture.js';

/** Controlled original broker/native composition, not public CLI inventory qualification. */
export async function runOriginalControlledSharedSANCase(options: {
  preflight: unknown;
  runtime: BrowserRuntimeDescriptor;
  nativeJournal: Awaited<ReturnType<typeof verifyInstalledNativeJournal>>;
  manager: ProcessIdentity;
  profileDir: string;
  subject: 'policy' | 'removed-admin-deny-mutant' | 'revocation';
  signal: AbortSignal;
  retain(report: unknown): Promise<void>;
}) {
  const retain = options.retain.bind(options);
  const endpoint = readOriginalQuickTunnelPort(options.preflight);
  const profile = ownDirectory(options.profileDir);
  const native = createDarwinEngineProcesses(options.nativeJournal.journal.artifact);
  const resolver = createProductionDestinationResolver();
  const known = new Map<string, ProcessIdentity>();
  const remember = (identity: ProcessIdentity) =>
    known.set(`${identity.pid}:${identity.birth}`, Object.freeze({ ...identity }));
  const denials: OriginalConnectDenial[] = [];
  let first: { value: unknown } | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const throwFirst = () => {
    if (first) throw first.value;
  };
  let admitted = false;
  let retired = false;
  const check = () => {
    throwFirst();
    options.signal.throwIfAborted();
    endpoint.assertCurrent();
    throwFirst();
  };
  const now = () => Math.floor(performance.now());
  const binding = Object.freeze({
    ownerId: 'owned-network-fixture',
    workspaceId: 'owned-network-fixture',
    browserId: randomUUID(),
    browserGeneration: 1,
  });
  const receiver = Object.freeze({
    browserId: binding.browserId,
    browserGeneration: binding.browserGeneration,
    isAuthorityCurrent: () => admitted && !retired && !first,
  });
  const policy = {
    revision: 1,
    adminAuthorities:
      options.subject === 'removed-admin-deny-mutant' ? [] : [endpoint.deniedOrigin],
    hostInterfaces: [],
    privateAdminEndpoints: [],
    resolver: resolver.resolve,
  };
  const observation = () => {
    check();
    if (!receiver.isAuthorityCurrent()) throw new Error('CONTROLLED_NATIVE_AUTHORITY_NOT_CURRENT');
    return {
      binding,
      ownerExists: true as const,
      retainedRun: true as const,
      grantsCurrent: true as const,
      custodyKnown: true as const,
      runtimePolicyKnown: true as const,
      runtimeIdentity: options.runtime.executable.sha256,
      authorizationEpoch: 1,
      policyRevision: 1,
      inventoryRevision: 1,
      monotonicNow: now(),
      utcNow: Date.now(),
      utcExpiresAt: Date.now() + 60000,
    };
  };
  const issuer = createBrokerIssuer({
    now,
    ports: {
      readCurrent: observation,
      readAuthority: async () => observation(),
      readPreparedPolicy: () => {
        check();
        return policy;
      },
      readInventory: () => {
        check();
        return {
          revision: 1,
          publicAuthoritiesKnown: true as const,
          localCoverageComplete: true,
          validUntil: now() + 1000,
          protectedEndpoints: [],
          declaredInstances: ['owned-preflight'],
          coveredInstances: ['owned-preflight'],
        };
      },
    },
  });
  const run = issuer.prepareRun(binding, {
    runtimeIdentity: options.runtime.executable.sha256,
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    receiver,
  });
  const originalTransport = createNodeBrokerTransport();
  const originalDial = originalTransport.dial.bind(originalTransport);
  const outgoing = new Map<object, { socket: OwnedSocket; returned: Promise<void> }>();
  const broker = createPreparedPrivateBroker({
    issuer,
    run,
    receiver,
    policy,
    transport: {
      ...originalTransport,
      dial: (selected, options) =>
        originalDial(selected, {
          ...options,
          onSocket(socket) {
            if (!outgoing.has(socket.identity)) {
              let returned!: () => void;
              const terminal = new Promise<void>((yes) => {
                returned = yes;
              });
              outgoing.set(socket.identity, { socket, returned: terminal });
              socket.onClose(returned);
            }
            return options.onSocket(socket);
          },
        }),
    },
    connectDenials(value) {
      if (denials.length >= 64) {
        fail(new Error('CONTROLLED_CONNECT_OBSERVATION_CAP'));
        return;
      }
      denials.push(Object.freeze({ ...value }));
    },
  });
  let client: Awaited<ReturnType<typeof startDarwinSupervisorClient>> | undefined;
  let wire: ReturnType<typeof createSupervisorProtocolWire> | undefined;
  let authentication: ReturnType<typeof createControllerProxyAuthentication> | undefined;
  let controller:
    Awaited<ReturnType<Awaited<ReturnType<typeof verifiedLibrary>>['connectOverCDP']>> | undefined;
  let nativeReturn: unknown;
  let browserLeafSHA256: string | undefined;
  let heldStream: unknown;
  const start = endpoint.observations().length;
  const nonce = randomUUID();
  let flow:
    | {
        warmProtocol: string;
        warmConnection: number;
        continueConnection: number;
        deniedObserved: boolean;
        attempts: Array<{ target: string; outcome: string }>;
      }
    | undefined;
  let bodyReturned!: () => void;
  const originalBody = new Promise<void>((yes) => {
    bodyReturned = yes;
  });
  const originalObservations: Promise<unknown>[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, refuse!: (value: unknown) => void;
    closing = new Promise<void>((yes, no) => {
      done = yes;
      refuse = no;
    });
    admitted = false;
    retired = true;
    const jobs: Promise<unknown>[] = [];
    const entered = new Set<string>();
    const enter = (name: string, owner: object | undefined, stop: () => unknown) => {
      if (!owner || entered.has(name)) return;
      entered.add(name);
      try {
        const original = Promise.resolve(stop());
        void original.catch(fail);
        jobs.push(original);
      } catch (value) {
        fail(value);
      }
    };
    const enterOriginals = () => {
      enter('controller', controller, () => controller!.close());
      enter('authentication', authentication, () => authentication!.close());
      enter('wire', wire, () => wire!.close());
      enter('native', client, async () => {
        const original = await client!.close();
        nativeReturn = original;
        if (original.pending || original.uncertain)
          throw new Error('CONTROLLED_NATIVE_RETURN_REFUSED');
      });
      enter('broker', broker, async () => {
        if (!(await broker.close())) throw new Error('CONTROLLED_BROKER_CLOSE_REFUSED');
      });
      enter('resolver', resolver, () => resolver.close());
    };
    void (async () => {
      try {
        await authentication?.prepareClose();
      } catch (value) {
        fail(value);
      }
      // Stop known originals now, then retain any genuine late constructor return.
      enterOriginals();
      await originalBody;
      enterOriginals();
      for (const row of await Promise.allSettled([
        ...jobs,
        ...originalObservations,
        ...[...outgoing.values()].map((row) => row.returned),
      ]))
        if (row.status === 'rejected') fail(row.reason);
    })().then(
      () => {
        options.signal.removeEventListener('abort', abort);
        if (first) refuse(first.value);
        else done();
      },
      (value) => {
        fail(value);
        options.signal.removeEventListener('abort', abort);
        refuse(first!.value);
      }
    );
    return closing;
  };
  const abort = () => {
    fail(options.signal.reason);
    void close().catch(fail);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    check();
    assertDirectory(profile);
    const descriptor = await broker.start();
    const peer = { url: descriptor.server, credentials: descriptor.credentials };
    client = await startDarwinSupervisorClient(
      {
        workerPath: options.nativeJournal.journal.browserWorkerPath!,
        browserId: binding.browserId,
        generation: 1,
        reservationNonce: randomUUID(),
        manager: options.manager,
        artifact: options.nativeJournal.journal.artifact,
        profileDir: profile.path,
        origin: 'about:blank',
        ownedProxy: peer,
        runtime: options.runtime,
      },
      undefined,
      undefined,
      async (original) => {
        original.identities.forEach(remember);
        remember(original.root);
        remember(original.supervisor);
        if (!original.complete) throw new Error('CONTROLLED_ORIGINAL_COHORT_INCOMPLETE');
      }
    );
    check();
    wire = createSupervisorProtocolWire(client.reportedEndpointURL);
    await wire.open();
    check();
    const catalogue = await readControllerOriginalCatalog(wire.transport);
    check();
    authentication = createControllerProxyAuthentication(
      wire.transport,
      peer,
      () => !retired && !first,
      fail,
      catalogue
    );
    controller = await (
      await verifiedLibrary(options.runtime)
    ).connectOverCDP(authentication.transport, { noDefaults: true });
    check();
    const page = controller.contexts()[0]?.pages()[0];
    if (!page || !authentication.isKnown()) throw new Error('CONTROLLED_ORIGINAL_PAGE_UNAVAILABLE');
    admitted = true;
    await broker.activate(receiver);
    const warmURL = `${endpoint.allowedOrigin}/warm/${nonce}`;
    const response = await page.goto(warmURL);
    if (response?.status() !== 200) throw new Error('CONTROLLED_WARM_RECEIPT_REQUIRED');
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Network.enable');
      // Original browser network events supply the protocol/connection, never endpoint JSON.
      const events: Array<{ url: string; protocol: string | undefined; connectionId: number }> = [];
      session.on('Network.responseReceived', (event) => {
        if (events.length >= 64) {
          fail(new Error('CONTROLLED_RESPONSE_EVENT_CAP'));
          return;
        }
        events.push({
          url: event.response.url,
          protocol: event.response.protocol,
          connectionId: event.response.connectionId,
        });
      });
      await page.goto(warmURL + '/observed');
      const chain = await session.send('Network.getCertificate', {
        origin: endpoint.allowedOrigin,
      });
      if (
        !Array.isArray(chain.tableNames) ||
        !chain.tableNames.length ||
        chain.tableNames.length > 16 ||
        typeof chain.tableNames[0] !== 'string' ||
        chain.tableNames[0].length > 16384
      )
        throw new Error('CONTROLLED_ORIGINAL_BROWSER_CERTIFICATE_REQUIRED');
      const leaf = new X509Certificate(Buffer.from(chain.tableNames[0], 'base64'));
      if (
        createHash('sha256').update(leaf.raw).digest('hex') !== endpoint.leafSHA256 ||
        !leaf.checkHost(new URL(endpoint.allowedOrigin).hostname, { subject: 'never' }) ||
        !leaf.checkHost(new URL(endpoint.deniedOrigin).hostname, { subject: 'never' })
      )
        throw new Error('CONTROLLED_ORIGINAL_BROWSER_SHARED_CERTIFICATE_REQUIRED');
      browserLeafSHA256 = createHash('sha256').update(leaf.raw).digest('hex');
      const actualPeers = [...outgoing.values()]
        .map((row) => row.socket.peer)
        .filter((peer) => peer !== undefined);
      if (
        !actualPeers.length ||
        actualPeers.some(
          (peer) => peer.port !== 443 || !endpoint.commonAddresses.includes(peer.address)
        )
      )
        throw new Error('CONTROLLED_ORIGINAL_BROWSER_SHARED_IP_REQUIRED');
      const warm = events.find((row) => row.url === warmURL + '/observed');
      if (!warm || warm.protocol !== 'h2') throw new Error('CONTROLLED_ORIGINAL_H2_WARM_REQUIRED');
      const attempts: Array<{ target: string; outcome: string }> = [];
      const verifyAttempt = (path: string, beforeDenials: number) => {
        check();
        const forbidden = endpoint
          .observations()
          .slice(start)
          .filter(
            (row) =>
              row.event === 'request' &&
              row.phase === 'matrix' &&
              row.role === 'denied' &&
              row.path === path
          );
        const denied = denials
          .slice(beforeDenials)
          .some(
            (row) =>
              row.browserId === binding.browserId &&
              row.browserGeneration === binding.browserGeneration &&
              row.authority === new URL(endpoint.deniedOrigin).hostname + ':443' &&
              row.beforeDial &&
              row.reason === 'ADMIN_DENIED'
          );
        if (options.subject === 'removed-admin-deny-mutant') {
          if (!forbidden.length || denied) throw new Error('CONTROLLED_ADMIN_MUTANT_NOT_EXERCISED');
        } else if (!denied || forbidden.length) {
          throw new Error('CONTROLLED_ADMIN_DENIAL_NOT_PROVED');
        }
        return denied;
      };
      let denied = false;
      for (const target of [
        'fetch',
        'image',
        'iframe',
        'dedicated-worker',
        'shared-worker',
      ] as const) {
        const path = `/forbidden/${nonce}/${target}`;
        const beforeDenials = denials.length;
        const outcome = await page.evaluate(
          async ({ target, url }) => {
            if (target === 'fetch') {
              try {
                const response = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
                await response.arrayBuffer();
                return 'fulfilled';
              } catch {
                return 'rejected';
              }
            }
            if (target === 'image' || target === 'iframe') {
              return await new Promise<string>((resolve) => {
                const element =
                  target === 'image'
                    ? document.createElement('img')
                    : document.createElement('iframe');
                const finish = (outcome: string) => {
                  element.onload = null;
                  element.onerror = null;
                  element.remove();
                  resolve(outcome);
                };
                element.onload = () => finish('load');
                element.onerror = () => finish('error');
                element.src = url;
                document.body.append(element);
              });
            }
            const script =
              target === 'dedicated-worker'
                ? `fetch(${JSON.stringify(url)}, {mode:'no-cors',cache:'no-store'}).then(r=>r.arrayBuffer()).then(()=>postMessage('fulfilled'),()=>postMessage('rejected'));`
                : `onconnect=e=>{const p=e.ports[0];fetch(${JSON.stringify(url)}, {mode:'no-cors',cache:'no-store'}).then(r=>r.arrayBuffer()).then(()=>p.postMessage('fulfilled'),()=>p.postMessage('rejected'));};`;
            const source = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
            try {
              return await new Promise<string>((resolve, reject) => {
                if (target === 'dedicated-worker') {
                  const worker = new Worker(source);
                  worker.onmessage = (event) => {
                    worker.terminate();
                    resolve(event.data);
                  };
                  worker.onerror = () => {
                    worker.terminate();
                    reject(new Error('CONTROLLED_WORKER_PRODUCER_FAILED'));
                  };
                } else {
                  const worker = new SharedWorker(source);
                  worker.port.onmessage = (event) => {
                    worker.port.close();
                    resolve(event.data);
                  };
                  worker.onerror = () => {
                    worker.port.close();
                    reject(new Error('CONTROLLED_SHARED_WORKER_PRODUCER_FAILED'));
                  };
                  worker.port.start();
                }
              });
            } finally {
              URL.revokeObjectURL(source);
            }
          },
          { target, url: endpoint.deniedOrigin + path }
        );
        denied = verifyAttempt(path, beforeDenials) || denied;
        attempts.push({ target, outcome });
      }
      const popupPath = `/forbidden/${nonce}/popup`;
      const beforePopup = denials.length;
      const popupId = `controlled-popup-${nonce}`;
      await page.evaluate(
        ({ id, url }) => {
          const anchor = document.createElement('a');
          anchor.id = id;
          anchor.href = url;
          anchor.target = '_blank';
          anchor.textContent = 'Open controlled destination';
          document.body.append(anchor);
        },
        { id: popupId, url: endpoint.deniedOrigin + popupPath }
      );
      const originalPopup = page.waitForEvent('popup');
      originalObservations.push(originalPopup);
      void originalPopup.catch(fail);
      let popup: typeof page | undefined;
      try {
        await page.locator(`#${popupId}`).click();
        popup = await originalPopup;
        await popup.waitForLoadState('load');
        denied = verifyAttempt(popupPath, beforePopup) || denied;
        attempts.push({ target: 'popup-navigation', outcome: 'load' });
      } catch (value) {
        fail(value);
      } finally {
        if (popup) await popup.close().catch(fail);
        // Failed clicks leave the original waiter in the close bank: native/SDK stop
        // enters before that waiter is joined, including a genuinely late popup.
      }
      check();
      const servicePath = `/forbidden/${nonce}/service-worker`;
      const beforeService = denials.length;
      const serviceOutcome = await page.evaluate(async (scriptURL) => {
        const registration = await navigator.serviceWorker.register(scriptURL);
        let failure: { value: unknown } | undefined;
        let outcome: string | undefined;
        try {
          const worker = registration.active ?? registration.installing ?? registration.waiting;
          if (!worker) throw new Error('CONTROLLED_SERVICE_WORKER_UNAVAILABLE');
          if (worker.state !== 'activated')
            await new Promise<void>((resolve, reject) => {
              const observe = () => {
                if (worker.state === 'activated') {
                  worker.removeEventListener('statechange', observe);
                  resolve();
                } else if (worker.state === 'redundant') {
                  worker.removeEventListener('statechange', observe);
                  reject(new Error('CONTROLLED_SERVICE_WORKER_REDUNDANT'));
                }
              };
              worker.addEventListener('statechange', observe);
              observe();
            });
          outcome = await new Promise<string>((resolve) => {
            const receive = (event: MessageEvent) => {
              if (event.source !== worker) return;
              navigator.serviceWorker.removeEventListener('message', receive);
              resolve(event.data);
            };
            navigator.serviceWorker.addEventListener('message', receive);
            worker.postMessage('original-request');
          });
        } catch (value) {
          failure = { value };
        } finally {
          try {
            await registration.unregister();
          } catch (value) {
            failure ??= { value };
          }
        }
        if (failure) throw failure.value;
        if (outcome !== 'fulfilled' && outcome !== 'rejected')
          throw new Error('CONTROLLED_SERVICE_WORKER_OUTCOME_INVALID');
        return outcome;
      }, `${endpoint.allowedOrigin}/service-worker/${nonce}.js`);
      denied = verifyAttempt(servicePath, beforeService) || denied;
      attempts.push({ target: 'service-worker', outcome: serviceOutcome });
      const socketAttempt = async (origin: string, marker: string) =>
        page.evaluate(
          async ({ url, marker }) => {
            return await new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(url);
              let outcome: 'echo' | 'error' | undefined;
              socket.onopen = () => {
                try {
                  socket.send(marker);
                } catch (value) {
                  socket.close();
                  reject(value);
                }
              };
              socket.onmessage = (event) => {
                if (event.data !== marker) {
                  socket.close();
                  reject(new Error('CONTROLLED_WSS_ECHO_MISMATCH'));
                  return;
                }
                outcome = 'echo';
                socket.close();
              };
              socket.onerror = () => {
                outcome ??= 'error';
                socket.close();
              };
              socket.onclose = () =>
                outcome ? resolve(outcome) : reject(new Error('CONTROLLED_WSS_UNOBSERVED'));
            });
          },
          { url: origin.replace(/^https:/, 'wss:') + '/socket/' + marker, marker }
        );
      const allowedSocket = randomUUID();
      if (
        (await socketAttempt(endpoint.allowedOrigin, allowedSocket)) !== 'echo' ||
        !endpoint
          .observations()
          .slice(start)
          .some(
            (row) =>
              row.event === 'request' &&
              row.phase === 'matrix' &&
              row.role === 'allowed' &&
              row.path === '/socket/' + allowedSocket
          )
      )
        throw new Error('CONTROLLED_ORIGINAL_WSS_POSITIVE_REQUIRED');
      const deniedSocket = randomUUID();
      const beforeSocket = denials.length;
      const socketOutcome = await socketAttempt(endpoint.deniedOrigin, deniedSocket);
      denied = verifyAttempt('/socket/' + deniedSocket, beforeSocket) || denied;
      if (socketOutcome !== (options.subject === 'removed-admin-deny-mutant' ? 'echo' : 'error'))
        throw new Error('CONTROLLED_ORIGINAL_WSS_OUTCOME_REQUIRED');
      attempts.push({ target: 'wss', outcome: socketOutcome });
      const redirect = randomUUID();
      const beforeRedirect = denials.length;
      let redirectOutcome = 'fulfilled';
      try {
        await page.goto(`${endpoint.allowedOrigin}/redirect/${redirect}`);
      } catch {
        redirectOutcome = 'rejected';
      }
      denied = verifyAttempt('/forbidden/' + redirect, beforeRedirect) || denied;
      if (
        !endpoint
          .observations()
          .slice(start)
          .some(
            (row) =>
              row.event === 'request' &&
              row.phase === 'matrix' &&
              row.role === 'allowed' &&
              row.path === '/redirect/' + redirect
          )
      )
        throw new Error('CONTROLLED_ORIGINAL_REDIRECT_REQUIRED');
      attempts.push({ target: 'navigation-redirect', outcome: redirectOutcome });
      check();
      const continuedURL = `${endpoint.allowedOrigin}/continue/${nonce}`;
      if ((await page.goto(continuedURL))?.status() !== 200)
        throw new Error('CONTROLLED_CONTINUE_REQUIRED');
      const continued = events.find((row) => row.url === continuedURL);
      if (!continued || continued.protocol !== 'h2' || continued.connectionId !== warm.connectionId)
        throw new Error('CONTROLLED_SAME_ORIGINAL_H2_CONNECTION_REQUIRED');
      const continuedRows = endpoint.observations().slice(start);
      if (
        !continuedRows.some(
          (row) =>
            row.event === 'request' &&
            row.phase === 'matrix' &&
            row.role === 'allowed' &&
            row.path === `/warm/${nonce}/observed`
        ) ||
        !continuedRows.some(
          (row) =>
            row.event === 'request' &&
            row.phase === 'matrix' &&
            row.role === 'allowed' &&
            row.path === `/continue/${nonce}`
        )
      )
        throw new Error('CONTROLLED_ORIGINAL_UPSTREAM_POSITIVES_REQUIRED');
      flow = {
        warmProtocol: warm.protocol,
        warmConnection: warm.connectionId,
        continueConnection: continued.connectionId,
        deniedObserved: denied,
        attempts,
      };
      if (options.subject === 'revocation') {
        const heldPath = `/hold/${nonce}`;
        const heldURL = endpoint.allowedOrigin + heldPath;
        const originalHeaders = page.waitForResponse(heldURL);
        originalObservations.push(originalHeaders);
        void originalHeaders.catch(fail);
        let revoking = false;
        let bodyReturned = false;
        const originalHeldBody = page
          .evaluate(async (url) => {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.status !== 200) throw new Error('CONTROLLED_HELD_RESPONSE_STATUS');
            await response.arrayBuffer();
          }, heldURL)
          .then(
            () => {
              bodyReturned = true;
              return 'fulfilled' as const;
            },
            (value) => {
              bodyReturned = true;
              if (!revoking) fail(value);
              return 'rejected' as const;
            }
          );
        originalObservations.push(originalHeldBody);
        const headers = await originalHeaders;
        check();
        if (
          headers.status() !== 200 ||
          bodyReturned ||
          !endpoint
            .observations()
            .slice(start)
            .some(
              (row) =>
                row.event === 'request' &&
                row.phase === 'matrix' &&
                row.role === 'allowed' &&
                row.path === heldPath
            )
        )
          throw new Error('CONTROLLED_ORIGINAL_HELD_RESPONSE_REQUIRED');
        const heldReturn = endpoint.awaitOriginalResponseClose('allowed', heldPath);
        if (
          endpoint
            .observations()
            .slice(start)
            .some(
              (row) =>
                row.event === 'response-close' &&
                row.phase === 'matrix' &&
                row.role === 'allowed' &&
                row.path === heldPath
            )
        )
          throw new Error('CONTROLLED_ORIGINAL_RESPONSE_ALREADY_CLOSED');
        const existing = [...outgoing.values()].filter((row) => !row.socket.observedClosed);
        if (!existing.length) throw new Error('CONTROLLED_LIVE_CIRCUIT_REQUIRED');
        revoking = true;
        issuer.revoke(run);
        retired = true;
        await Promise.all(existing.map((row) => row.returned));
        const interrupted = await originalHeldBody;
        await heldReturn;
        check();
        if (
          interrupted !== 'rejected' ||
          !endpoint
            .observations()
            .slice(start)
            .some(
              (row) =>
                row.event === 'response-close' &&
                row.phase === 'matrix' &&
                row.role === 'allowed' &&
                row.path === heldPath
            )
        )
          throw new Error('CONTROLLED_ORIGINAL_HELD_INTERRUPTION_REQUIRED');
        heldStream = {
          headers: 200,
          heldBeforeRevoke: true,
          body: interrupted,
          upstreamClosed: true,
        };
        if (existing.some((row) => !row.socket.observedClosed))
          throw new Error('CONTROLLED_REVOKED_CIRCUIT_NOT_CLOSED');
        const after = `${endpoint.allowedOrigin}/after-revocation/${nonce}`;
        let rejection: { value: unknown } | undefined;
        try {
          await page.goto(after);
        } catch (value) {
          rejection = { value };
        }

        if (
          !rejection ||
          endpoint
            .observations()
            .slice(start)
            .some((row) => row.path.includes('/after-revocation') && row.path.includes(nonce))
        )
          throw new Error('CONTROLLED_REVOCATION_NOT_PROVED');
      }
    } catch (value) {
      fail(value);
    } finally {
      try {
        await session.detach();
      } catch (value) {
        fail(value);
      }
    }
  } catch (value) {
    fail(value);
  } finally {
    bodyReturned();
    try {
      await close();
    } catch (value) {
      fail(value);
    }
    const observations = await Promise.all(
      [...known.values()].map(async (identity) => ({
        identity,
        status: await native.observeTerminated(identity, new AbortController().signal).then(
          (row) => row.status,
          (value) => {
            fail(value);
            return 'unknown' as const;
          }
        ),
      }))
    );
    if (observations.some((row) => row.status !== 'dead'))
      fail(new Error('CONTROLLED_ORIGINAL_NATIVE_CUSTODY_UNKNOWN'));
    let rows: ReturnType<typeof endpoint.observations> | undefined;
    try {
      rows = endpoint.observations().slice(start);
    } catch (value) {
      fail(value);
    }
    await retain({
      kind: 'controlled-original-shared-san-native',
      subject: options.subject,
      binding,
      nonce,
      scope: 'constructor-owned broker/native; not public CLI inventory',
      flow,
      browserLeafSHA256: browserLeafSHA256 ?? null,
      denials,
      heldStream: heldStream ?? null,
      rows: rows ?? null,
      endpointRowsUnavailable: rows === undefined,
      nativeReturn,
      knownBirths: [...known.values()],
      observations,
      returned: first ? 'FAIL' : 'PASS',
    }).catch(fail);
  }
  if (first) throw first.value;
}
