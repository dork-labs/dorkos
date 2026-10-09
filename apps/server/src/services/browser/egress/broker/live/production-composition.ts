import { Server, Socket } from 'node:net';
import {
  createOriginalBrowserViewerDiagnostic,
  type BrowserViewerDiagnosticStage,
} from '../../../stream/viewer-diagnostic.js';
import { validateEngineConfiguration, type BrowserBinding } from '@dorkos/browser';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
import { createProductionBrowserAuthority } from './production-authority.js';
import { createBrokerIssuer, type RunHandle } from '../issuer.js';
import { createPreparedProductionBroker } from '../production-broker.js';
import { createLiveBrowserInventory } from './live-inventory.js';
import { createProductionDestinationResolver } from '../../node-resolver.js';
import { BrokerError } from '../errors.js';
import type {
  PrivateLiveNetworkPeer,
  PrivateLiveBrowserParticipants,
  PrivateWorkspaceBrowserGrant,
} from './authority-core.js';
import type { EgressPolicyOptions } from '../../settings.js';
import type { OwnedListener } from '../transport.js';

/** Only the genuine prepared production branch below can mint this handle. */
export interface OriginalPreparedBrokerEndpoint {
  readonly kind: 'original-prepared-broker-endpoint';
}
type OriginalEndpoint = {
  check(): Readonly<{ port: number }>;
  sockets: Set<OriginalBrokerConnection>;
  retired: boolean;
};
const originalEndpoints = new WeakMap<object, OriginalEndpoint>();
export interface OriginalBrokerConnection {
  readonly socket: Socket;
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  check(): void;
  close(): Promise<void>;
}
/** Genuine Node Socket; its original close is captured before connect or guards.
 * The consumer must retain every entered read/write callback and join close(). */
export function connectOriginalPreparedBrokerEndpoint(token: unknown): OriginalBrokerConnection {
  const state =
    typeof token === 'object' && token !== null ? originalEndpoints.get(token) : undefined;
  if (!state) throw new BrokerError('AUTHORITY_REFUSED');
  if (state.retired || state.sockets.size >= 16) throw new BrokerError('CLOSED');
  const socket = new Socket({ allowHalfOpen: true });
  let done!: () => void, yes!: () => void, no!: (value: unknown) => void;
  let finished = false,
    ready = false,
    closing = false,
    first: { value: unknown } | undefined;
  const closed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const connected = new Promise<void>((resolve, reject) => {
    yes = resolve;
    no = reject;
  });
  void connected.catch(() => {});
  const check = () => {
    if (first) throw first.value;
    if (closing || finished || state.retired) throw new BrokerError('CLOSED');
    state.check();
    if (closing || finished || state.retired) throw new BrokerError('CLOSED');
  };
  const connection: OriginalBrokerConnection = Object.freeze({
    socket,
    connected,
    closed,
    check,
    close() {
      closing = true;
      socket.destroy();
      return closed;
    },
  });
  state.sockets.add(connection); // Original retained before any fallible authority lookup.
  socket.once('close', () => {
    finished = true;
    if (!ready) no(first ? first.value : new BrokerError('CLOSED'));
    state.sockets.delete(connection);
    done();
  });
  socket.on('error', (value) => {
    first ??= { value };
    no(first.value);
    socket.destroy();
  });
  socket.once('connect', () => {
    try {
      check();
      ready = true;
      yes();
    } catch (value) {
      first ??= { value };
      no(first.value);
      socket.destroy();
    }
  });
  try {
    const endpoint = state.check();
    check();
    socket.connect({ host: '127.0.0.1', port: endpoint.port });
  } catch (value) {
    first ??= { value };
    no(first.value);
    socket.destroy();
  }
  return connection;
}
function retireOriginalEndpoint(state: OriginalEndpoint): Promise<void> {
  state.retired = true;
  const jobs: Promise<unknown>[] = [];
  let first: { value: unknown } | undefined;
  for (const original of state.sockets) {
    try {
      jobs.push(original.close());
    } catch (value) {
      first ??= { value };
    }
  }
  return Promise.allSettled(jobs).then((rows) => {
    for (const row of rows) if (row.status === 'rejected') first ??= { value: row.reason };
    if (first) throw first.value;
  });
}

/** Production original session/native/lease/protected-boundary assembly, with no fixture creator,
 * fixture-origin grants or caller-supplied DNS/IO/readiness. The startup owner retains close. */
export function createProductionLiveBrowserComposition(
  options: Omit<
    Parameters<typeof createProductionBrowserAuthority>[0],
    'inventory' | 'checkOwnedOrigins' | 'readPreparedPolicy'
  > & {
    inventory: Parameters<typeof createLiveBrowserInventory>[0];
    engineConfiguration: unknown;
  }
) {
  const config = validateEngineConfiguration(options.engineConfiguration);
  const admissionDiagnostic = createOriginalBrowserViewerDiagnostic();
  if (
    config.network.kind !== 'owned' ||
    config.runtime.identity.mode !== 'native' ||
    !config.nativeJournal
  )
    throw new BrokerError('UNAVAILABLE');
  const revision = config.network.policyRevision;
  const inventory = createLiveBrowserInventory(options.inventory);
  const resolver = createProductionDestinationResolver();
  const peers = new Map<
    PrivateLiveNetworkPeer,
    {
      receiver: PrivateBrowserRetirementReceiver;
      broker: ReturnType<typeof createPreparedProductionBroker>;
      listener: OwnedListener;
      run: RunHandle;
      grant: PrivateWorkspaceBrowserGrant;
      policy?: EgressPolicyOptions;
      sealed?: number;
      sealStarted: boolean;
      activateEndpoint(): void;
    }
  >();
  const retained = new Set<ReturnType<typeof createPreparedProductionBroker>>();
  const endpoints = new Set<OriginalEndpoint>();
  let retainedFailure: Readonly<{ value: unknown }> | undefined;
  let stopped = false,
    closing: Promise<void> | undefined;
  const authority = createProductionBrowserAuthority({
    ...options,
    inventory,
    policyRevision: revision,
    readPreparedPolicy(_binding, receiver) {
      const original = [...peers.values()].find((state) => state.receiver === receiver);
      if (!original || stopped) throw new BrokerError('AUTHORITY_REFUSED');
      if (!original.policy) {
        if (original.sealStarted) throw new BrokerError('AUTHORITY_REFUSED');
        original.sealStarted = true;
        inventory.retainBrowserAdmin(original.listener.identity);
        const actual = inventory.observe();
        if (!actual.policyInputs) throw new BrokerError('AUTHORITY_REFUSED');
        original.sealed = actual.inventory.revision;
        original.policy = Object.freeze({
          revision,
          ...actual.policyInputs,
          resolver: resolver.resolve,
        });
      }
      if (inventory.readInventory().revision !== original.sealed)
        throw new BrokerError('AUTHORITY_REFUSED');
      return original.policy;
    },
  });
  const issuer = createBrokerIssuer({
    ports: authority.ports,
    now: options.now,
  });
  let originalOpen: Promise<Awaited<ReturnType<typeof authority.openEngine>>> | undefined;
  let acquired: Awaited<ReturnType<typeof authority.openEngine>> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, reject!: (reason: unknown) => void;
    closing = new Promise<void>((yes, no) => {
      done = yes;
      reject = no;
    });
    stopped = true;
    let failed = false,
      first: unknown;
    const record = (reason: unknown) => {
      retainedFailure ??= Object.freeze({ value: reason });
      if (!failed) {
        failed = true;
        first = reason;
      }
    };
    if (retainedFailure) record(retainedFailure.value);
    const jobs: Promise<unknown>[] = [];
    for (const effect of [
      ...[...endpoints].map((endpoint) => () => retireOriginalEndpoint(endpoint)),
      () => authority.close(),
      () => resolver.close(),
      ...[...retained].map((broker) => async () => {
        if (!(await broker.close())) throw new BrokerError('CLOSED');
        retained.delete(broker);
      }),
    ]) {
      try {
        jobs.push(Promise.resolve(effect()));
      } catch (error) {
        record(error);
      }
    }
    // Late original engine/network acquisition remains retained and joins the same natural work.
    if (originalOpen)
      jobs.push(
        originalOpen.then(
          () => undefined,
          (error) => {
            record(error);
          }
        )
      );
    void Promise.allSettled(jobs).then((results) => {
      for (const result of results) if (result.status === 'rejected') record(result.reason);
      if (retainedFailure) record(retainedFailure.value);
      if (failed) reject(first);
      else done();
    });
    return closing;
  };
  return Object.freeze({
    authority,
    issuer,
    close,
    authorizeWorkspace: authority.authorizeWorkspace,
    authorizeRuntimeWorkspace: authority.authorizeRuntimeWorkspace,
    authorizeWorkspaceRequest: authority.authorizeWorkspaceRequest,
    /** Only the retained original browser/owner issuer can approve one finite local HTTP endpoint. */
    allowLocalDestination(
      binding: Pick<BrowserBinding, 'browserId' | 'browserGeneration'>,
      url: string,
      ttl: number,
      originalOwnerCurrent: () => boolean,
      onOriginalDenial: (value: BrokerError) => void
    ) {
      const current = originalOwnerCurrent;
      const report = onOriginalDenial;
      const refusal = () => {
        const original = new BrokerError('AUTHORITY_REFUSED');
        report(original);
        return original;
      };
      if (retainedFailure) throw retainedFailure.value;
      if (stopped || !current() || stopped) throw refusal();
      const matches = [...peers.values()].filter(
        (state) =>
          state.receiver.browserId === binding.browserId &&
          state.receiver.browserGeneration === binding.browserGeneration
      );
      if (matches.length !== 1) throw refusal();
      const original = matches[0]!;
      authority.authorizeBrowserAction(original.grant, binding);
      issuer.check(original.run);
      if (!current() || stopped || !original.broker.isCustodyKnown() || !current() || stopped)
        throw refusal();
      original.broker.grantLocal(url, 'http', ttl, report);
      if (!current() || stopped) {
        original.broker.revokeLocal();
        throw refusal();
      }
    },
    async open(
      grant: PrivateWorkspaceBrowserGrant,
      command: unknown,
      participant: PrivateLiveBrowserParticipants,
      initialStorageState?: unknown
    ) {
      if (stopped || originalOpen) throw new BrokerError('CLOSED');
      originalOpen = Promise.resolve()
        .then(() => {
          if (stopped) throw new BrokerError('CLOSED');
          return authority.openEngine(
            grant,
            {
              ...config,
              policy: {
                async authorizeAction(
                  binding: Pick<BrowserBinding, 'browserId' | 'browserGeneration'>,
                  signal: AbortSignal
                ) {
                  if (signal.aborted || stopped) return 'refused' as const;
                  try {
                    authority.authorizeBrowserAction(grant, binding);
                    return signal.aborted || stopped ? ('refused' as const) : ('allowed' as const);
                  } catch {
                    return 'refused' as const;
                  }
                },
                async verifyBrokerLease(
                  binding: {
                    browserId: string;
                    browserGeneration: number;
                    leaseId: string;
                    policyRevision: number;
                  },
                  signal: AbortSignal
                ) {
                  if (signal.aborted || stopped) return 'revoked' as const;
                  try {
                    const state = [...peers.values()].find(
                      (entry) =>
                        entry.receiver.browserId === binding.browserId &&
                        entry.receiver.browserGeneration === binding.browserGeneration
                    );
                    if (
                      !state ||
                      binding.policyRevision !== revision ||
                      !state.broker.isCustodyKnown()
                    )
                      return 'unknown' as const;
                    authority.authorizeBrowserAction(grant, binding);
                    issuer.check(state.run);
                    // Original broker validates its credential/lease on each forwarding operation; a body
                    // lease ID cannot choose or renew a run. Unknown external lease IDs remain refused.
                    return 'unknown' as const;
                  } catch {
                    return 'revoked' as const;
                  }
                },
              },
            },
            command,
            {
              async prepare(context) {
                if (stopped) throw new BrokerError('CLOSED');
                const snapshot = inventory.observe();
                if (!snapshot.policyInputs) throw new BrokerError('AUTHORITY_REFUSED');
                const run = issuer.prepareRun(context.binding, {
                  runtimeIdentity: context.runtimeIdentity,
                  authorizationEpoch: context.authorizationEpoch,
                  policyRevision: context.policyRevision,
                  inventoryRevision: snapshot.inventory.revision,
                  receiver: context.receiver,
                });
                let broker: ReturnType<typeof createPreparedProductionBroker>;
                try {
                  broker = createPreparedProductionBroker({
                    issuer,
                    run,
                    receiver: context.receiver,
                    policy: {
                      revision,
                      ...snapshot.policyInputs,
                      resolver: resolver.resolve,
                    },
                  });
                } catch (error) {
                  issuer.releaseRun(run);
                  throw error;
                }
                retained.add(broker);
                try {
                  const descriptor = await broker.start();
                  const listener = broker.ownedListener();
                  if (!listener || stopped) throw new BrokerError('CLOSED');
                  inventory.retainListener(listener, context.receiver);
                  const known = broker.isCustodyKnown.bind(broker),
                    originalClose = broker.close.bind(broker);
                  const originalServer = listener.identity;
                  if (!(originalServer instanceof Server))
                    throw new BrokerError('AUTHORITY_REFUSED');
                  const address = originalServer.address();
                  if (
                    !address ||
                    typeof address === 'string' ||
                    address.address !== '127.0.0.1' ||
                    address.port !== listener.port
                  )
                    throw new BrokerError('AUTHORITY_REFUSED');
                  const port = address.port;
                  const ordinary = context.receiver.isOrdinary.bind(context.receiver);
                  let activated = false;
                  const endpoint: OriginalEndpoint = {
                    retired: false,
                    sockets: new Set(),
                    check() {
                      const original = peers.get(peer);
                      if (
                        stopped ||
                        endpoint.retired ||
                        !original ||
                        original.listener !== listener ||
                        original.receiver !== context.receiver ||
                        !broker.isCustodyKnown() ||
                        listener.isCustodyKnown?.() !== true
                      )
                        throw new BrokerError('AUTHORITY_REFUSED');
                      if (!ordinary()) throw new BrokerError('AUTHORITY_REFUSED');
                      if (activated) issuer.check(run);
                      else issuer.checkPrepared(run, context.receiver);
                      const current = originalServer.address();
                      if (
                        !current ||
                        typeof current === 'string' ||
                        current.address !== '127.0.0.1' ||
                        current.port !== port ||
                        listener.identity !== originalServer ||
                        listener.port !== port
                      )
                        throw new BrokerError('AUTHORITY_REFUSED');
                      if (
                        stopped ||
                        endpoint.retired ||
                        peers.get(peer) !== original ||
                        !broker.isCustodyKnown() ||
                        !ordinary()
                      )
                        throw new BrokerError('AUTHORITY_REFUSED');
                      return Object.freeze({ port });
                    },
                  };
                  const endpointToken = Object.freeze({
                    kind: 'original-prepared-broker-endpoint' as const,
                  });
                  originalEndpoints.set(endpointToken, endpoint);
                  endpoints.add(endpoint);
                  const peer: PrivateLiveNetworkPeer = Object.freeze({
                    originalSerialProxyEndpoint() {
                      endpoint.check();
                      return endpointToken;
                    },
                    url: descriptor.server,
                    authenticationWarmup: descriptor.authenticationWarmup,
                    credentials: Object.freeze({
                      username: 'dorkos',
                      password: descriptor.credential,
                    }),
                    isCustodyKnown: () => !stopped && known(),
                    async close() {
                      endpoint.retired = true;
                      let failure: { value: unknown } | undefined;
                      const join = (job: Promise<unknown>) =>
                        job.catch((value) => {
                          failure ??= { value };
                          throw value;
                        });
                      const joined = await Promise.allSettled([
                        join(retireOriginalEndpoint(endpoint)),
                        join(
                          Promise.resolve().then(async () => {
                            if (!(await originalClose())) throw new BrokerError('CLOSED');
                          })
                        ),
                      ]);
                      if (failure) throw failure.value;
                      for (const row of joined) if (row.status === 'rejected') throw row.reason;
                      endpoints.delete(endpoint);
                      peers.delete(peer);
                      retained.delete(broker);
                    },
                  });
                  peers.set(peer, {
                    receiver: context.receiver,
                    broker,
                    listener,
                    run,
                    grant,
                    sealStarted: false,
                    activateEndpoint: () => {
                      activated = true;
                      endpoint.check();
                    },
                  });
                  return peer;
                } catch (error) {
                  retainedFailure ??= Object.freeze({ value: error });
                  try {
                    if (await broker.close()) retained.delete(broker);
                    else
                      retainedFailure ??= Object.freeze({
                        value: new BrokerError('CLOSED'),
                      });
                  } catch (cleanupError) {
                    retainedFailure ??= Object.freeze({ value: cleanupError });
                  }
                  throw error;
                }
              },
              async activate(receiver, peer) {
                const original = peers.get(peer);
                if (
                  !original ||
                  original.receiver !== receiver ||
                  stopped ||
                  !peer.isCustodyKnown()
                )
                  throw new BrokerError('AUTHORITY_REFUSED');
                await original.broker.activate(receiver);
                original.activateEndpoint();
                if (stopped || !peer.isCustodyKnown()) throw new BrokerError('AUTHORITY_REFUSED');
              },
            },
            participant,
            initialStorageState
          );
        })
        .then((original) => {
          acquired = original;
          if (stopped) throw new BrokerError('CLOSED');
          return original;
        });
      void originalOpen.catch((error) => {
        retainedFailure ??= Object.freeze({ value: error });
        void close().catch(() => {});
      });
      return originalOpen;
    },
    /** True only for this exact retained engine/native receiver and fresh original SQL/lease ports. */
    isCurrent(grant: PrivateWorkspaceBrowserGrant): boolean {
      let stage: BrowserViewerDiagnosticStage = 'network.stopped';
      const refuse = () => {
        admissionDiagnostic.note(stage);
        return false;
      };
      // Preserve original pre-try native failures: these did not enter network close.
      try {
        if (stopped) return refuse();
        stage = 'network.acquired';
        if (!acquired) return refuse();
        stage = 'network.native-before';
        if (!authority.runtime.isNativeCurrent(acquired.engine)) return refuse();
      } catch (value) {
        admissionDiagnostic.failure(stage, value);
        throw value;
      }
      try {
        stage = 'network.authorize';
        authority.authorizeOriginal(grant, acquired.binding);
        stage = 'network.peer';
        const state = [...peers.values()].find(
          (entry) =>
            entry.receiver.browserId === acquired!.binding.browserId &&
            entry.receiver.browserGeneration === acquired!.binding.browserGeneration
        );
        if (!state || !state.broker.isCustodyKnown()) throw new BrokerError('AUTHORITY_REFUSED');
        stage = 'network.issuer';
        issuer.check(state.run);
        stage = 'network.stopped';
        if (stopped) return refuse();
        stage = 'network.native-after';
        const admitted = authority.runtime.isNativeCurrent(acquired.engine);
        if (!admitted) admissionDiagnostic.note(stage);
        return admitted;
      } catch (value) {
        // Original irreversible close enters before any non-authoritative diagnostic sink.
        void close().catch(() => {});
        admissionDiagnostic.failure(stage, value);
        return false;
      }
    },
    async navigate(grant: PrivateWorkspaceBrowserGrant, url: string, requestId: string) {
      if (stopped || !acquired) throw new BrokerError('CLOSED');
      authority.authorizeOriginal(grant, acquired.binding);
      const original = [...peers.values()].find(
        (entry) =>
          entry.receiver.browserId === acquired!.binding.browserId &&
          entry.receiver.browserGeneration === acquired!.binding.browserGeneration
      );
      if (!original) throw new BrokerError('AUTHORITY_REFUSED');
      issuer.check(original.run);
      const tab = acquired.engine
        .listTabs(acquired.binding.browserId, acquired.binding.browserGeneration)
        .find((entry) => entry.tabId === acquired!.opened.tab.tabId);
      if (!tab) throw new BrokerError('AUTHORITY_REFUSED');
      authority.authorizeOriginal(grant, acquired.binding);
      const navigate = original.receiver.navigateInitial.bind(original.receiver);
      if (stopped) throw new BrokerError('CLOSED');
      authority.authorizeOriginal(grant, acquired.binding);
      issuer.check(original.run);
      const binding = await navigate({
        kind: 'navigate',
        requestId,
        binding: tab,
        url,
      });
      authority.authorizeOriginal(grant, acquired.binding);
      const current = acquired.engine
        .listTabs(binding.browserId, binding.browserGeneration)
        .find((tab) => tab.tabId === binding.tabId);
      issuer.check(original.run);
      if (!current || JSON.stringify(current) !== JSON.stringify(binding) || stopped)
        throw new BrokerError('AUTHORITY_REFUSED');
      return binding;
    },
  });
}
