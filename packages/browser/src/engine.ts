import {
  installOwnerNavigation,
  type PrivateOwnerNavigationContinuation,
} from './navigation/owner-continuation.js';
import { navigateOwned } from './navigation/navigate.js';
import { navigationPending } from './navigation/cohort.js';
import {
  createOwnedNavigationIssuer,
  type OwnedNavigationAuthorization,
} from './navigation/owned-work.js';
import {
  createOwnedCaptureIssuer,
  type OwnedCaptureAuthorization,
  type OwnedCaptureWork,
} from './tabs/owned-capture-work.js';
import { createOwnedInputIssuer, type OwnedInputAuthorization } from './input/owned-work.js';
import { navigateOwnedInitial } from './lifecycle/initial-navigation.js';
import { initialNavigationPending } from './lifecycle/initial-navigation-state.js';
import { currentAuthorityCustody } from './lifecycle/live-custody.js';
import { createDiagnosticsBudget } from './tabs/diagnostics-budget.js';
import { randomBytes, createHash } from 'node:crypto';
import {
  createDarwinGenerationReturnOwner,
  type DarwinGenerationReturn,
  type DarwinGenerationBinding,
} from './runtime/darwin-generation-return.js';
import { validateEngineConfiguration } from './configuration.js';
import {
  parseBrowserBinding,
  parseBrowserCommand,
  parseBrowserResult,
  type BrowserBinding,
  type BrowserResult,
} from './contracts.js';
import { parseBrowserId } from './ids.js';
import { createDarwinEngineProcesses } from './runtime/darwin-engine-processes.js';
import { hostIdentity } from './runtime/host-identity.js';
import { acquireBrowser } from './lifecycle/acquisition.js';
import { closeRecord } from './lifecycle/close.js';
import { BrowserLifecycleError } from './lifecycle/errors.js';
import type { BrowserRecord, OpenedResult } from './lifecycle/records.js';
import {
  createBrowserLifetime,
  ownOperation,
  bindOrdinaryRecord,
  ordinaryRecord,
  fenceOrdinary,
  installRetirementDriver,
} from './lifecycle/ownership.js';
import { submitInput, resetInput } from './lifecycle/parent-actions.js';
import type { InputResult, ResetResult } from './input/types.js';
import { until } from './lifecycle/deadline.js';
import { sameBinding } from './input/binding.js';
import { captureTab, type BrowserCapture } from './tabs/capture.js';

/** Private canonical input/capture/lifecycle composition; native production readiness is separate. */
export interface BrowserLifecycleEngine {
  open(command: unknown): Promise<OpenedResult>;
  listTabs(browserId: string, browserGeneration: number): readonly BrowserBinding[];
  capture(command: unknown): Promise<BrowserCapture>;
  input(command: unknown, signal?: AbortSignal): Promise<InputResult>;
  resetInput(binding: unknown): Promise<ResetResult>;
  close(command: unknown): Promise<Extract<BrowserResult, { kind: 'close' }>>;
  shutdown(): Promise<readonly Extract<BrowserResult, { kind: 'close' }>[]>;
}

/** Proposed private retirement-only handoff: no record Map, admission grant or cleanup permit escapes. */
export interface PrivateBrowserRetirementReceiver {
  readonly browserId: string;
  readonly browserGeneration: number;
  /** Immutable acquisition metadata from the original parsed record, before native birth. */
  readonly acquisition: Readonly<{ mode: 'persistent'; profileId: string } | { mode: 'ephemeral' }>;
  readonly observation: Promise<import('./lifecycle/ownership.js').RetirementObservation>;
  isOrdinary(): boolean;
  isAuthorityCurrent(): boolean;
  navigateInitial(command: unknown): Promise<Readonly<BrowserBinding>>;
  verifiedBrowserAdminEndpoint(): Readonly<{
    url: string;
    root: import('./configuration.js').ProcessIdentity;
    supervisor: import('./configuration.js').ProcessIdentity;
  }> | null;
  verifiedRuntimeBinding(): Readonly<{
    runtimeIdentity: string;
    policyRevision: number;
  }> | null;
  disabled(): Promise<import('./lifecycle/ownership.js').RetirementObservation>;
  authorityRevoked(): Promise<import('./lifecycle/ownership.js').RetirementObservation>;
  persistenceFailure(): Promise<import('./lifecycle/ownership.js').RetirementObservation>;
  generationReturned(): Promise<DarwinGenerationReturn | null>;
  consumeGenerationReturn(token: unknown, binding: DarwinGenerationBinding): boolean;
}
/** Constructor-private input dispatcher; tokens never cross the wire or public engine. */
export interface PrivateBrowserInputDispatcher {
  input(
    command: unknown,
    authorization: OwnedInputAuthorization,
    signal?: AbortSignal
  ): Promise<InputResult>;
}
/** Trusted server constructor captures the original dispatcher before any open. */
export interface PrivateBrowserInputOwner {
  registerDispatcher(dispatcher: PrivateBrowserInputDispatcher): void;
}
/** Constructor-private raster dispatcher; JSON commands never carry its authority. */
export interface PrivateBrowserCaptureDispatcher {
  capture(value: unknown, authorization: OwnedCaptureAuthorization): Promise<BrowserCapture>;
}
export interface PrivateBrowserCaptureOwner {
  registerDispatcher(dispatcher: PrivateBrowserCaptureDispatcher): void;
}
/** Original trusted network peer; credentials stay in the private owned composition. */
export interface PrivateBrowserNetworkPeer {
  readonly url: string;
  readonly credentials: Readonly<{ username: string; password: string }>;
  isCustodyKnown(): boolean;
  close(): Promise<void>;
}
/** Captured before births; cold preparation conveys no ready authority. */
export interface PrivateBrowserNetworkOwner {
  bindBeforeLaunch(receiver: PrivateBrowserRetirementReceiver): Promise<PrivateBrowserNetworkPeer>;
  activateReady(
    receiver: PrivateBrowserRetirementReceiver,
    peer: PrivateBrowserNetworkPeer
  ): Promise<void>;
}
/** Private original command dispatcher; never the public BrowserLifecycleEngine surface. */
export interface PrivateBrowserNavigationDispatcher {
  navigate(
    command: unknown,
    authorization: OwnedNavigationAuthorization,
    signal?: AbortSignal
  ): Promise<Readonly<BrowserBinding>>;
}
/** One constructor captures one original dispatcher receiver. */
export interface PrivateBrowserNavigationOwner {
  readonly continuation?: PrivateOwnerNavigationContinuation;
  observeLifetime?(
    receiver: Pick<
      PrivateBrowserRetirementReceiver,
      'browserId' | 'browserGeneration' | 'observation'
    >
  ): void;
  registerDispatcher(dispatcher: PrivateBrowserNavigationDispatcher): void;
}
export interface PrivateBrowserBirthOwner {
  readonly navigation?: PrivateBrowserNavigationOwner;
  readonly input?: PrivateBrowserInputOwner;
  readonly capture?: PrivateBrowserCaptureOwner;
  readonly network?: PrivateBrowserNetworkOwner;
  registerBirth(receiver: PrivateBrowserRetirementReceiver): void;
  refuseBirth(receiver: PrivateBrowserRetirementReceiver): void;
}
type EngineConstruction =
  | Readonly<{ kind: 'engineLocalFixture' }>
  | Readonly<{
      kind: 'serverOwned';
      owner: PrivateBrowserBirthOwner;
      registerBirth: PrivateBrowserBirthOwner['registerBirth'];
      refuseBirth: PrivateBrowserBirthOwner['refuseBirth'];
      navigation?: Readonly<{
        owner: PrivateBrowserNavigationOwner;
        registerDispatcher: PrivateBrowserNavigationOwner['registerDispatcher'];
        continuation?: PrivateOwnerNavigationContinuation;
        observeLifetime?: PrivateBrowserNavigationOwner['observeLifetime'];
      }>;
      input?: Readonly<{
        owner: PrivateBrowserInputOwner;
        registerDispatcher: PrivateBrowserInputOwner['registerDispatcher'];
      }>;
      capture?: Readonly<{
        owner: PrivateBrowserCaptureOwner;
        registerDispatcher: PrivateBrowserCaptureOwner['registerDispatcher'];
      }>;
      network?: Readonly<{
        owner: PrivateBrowserNetworkOwner;
        bindBeforeLaunch: PrivateBrowserNetworkOwner['bindBeforeLaunch'];
        activateReady: PrivateBrowserNetworkOwner['activateReady'];
      }>;
    }>;

/** Existing fixture command surface; this is not the future authenticated server constructor. */
export function createBrowserEngine(configuration: unknown): BrowserLifecycleEngine {
  return constructEngine(configuration, Object.freeze({ kind: 'engineLocalFixture' }));
}

/** Backend-only constructor captures original dispatchers before any canonical browser birth. */
export function constructOwnedBrowserEngine(
  configuration: unknown,
  owner: PrivateBrowserBirthOwner
): BrowserLifecycleEngine {
  // Capture exact callback receivers once before configuration may observe external values.
  const registerBirth = owner.registerBirth;
  const refuseBirth = owner.refuseBirth;
  if (typeof registerBirth !== 'function' || typeof refuseBirth !== 'function')
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  const navigationOwner = owner.navigation;
  const originalContinuation = navigationOwner?.continuation;
  const continuation = originalContinuation
    ? Object.freeze({
        acquire: originalContinuation.acquire.bind(originalContinuation),
        joinPublications: originalContinuation.joinPublications.bind(originalContinuation),
        observeTransition: originalContinuation.observeTransition?.bind(originalContinuation),
      })
    : undefined;
  const navigation = navigationOwner
    ? Object.freeze({
        owner: navigationOwner,
        registerDispatcher: navigationOwner.registerDispatcher,
        continuation,
        observeLifetime: navigationOwner.observeLifetime,
      })
    : undefined;
  if (navigation && typeof navigation.registerDispatcher !== 'function')
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  const inputOwner = owner.input;
  const input = inputOwner
    ? Object.freeze({
        owner: inputOwner,
        registerDispatcher: inputOwner.registerDispatcher,
      })
    : undefined;
  if (input && typeof input.registerDispatcher !== 'function')
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  const captureOwner = owner.capture;
  const capture = captureOwner
    ? Object.freeze({
        owner: captureOwner,
        registerDispatcher: captureOwner.registerDispatcher,
      })
    : undefined;
  if (capture && typeof capture.registerDispatcher !== 'function')
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  const networkOwner = owner.network;
  const network = networkOwner
    ? Object.freeze({
        owner: networkOwner,
        bindBeforeLaunch: networkOwner.bindBeforeLaunch,
        activateReady: networkOwner.activateReady,
      })
    : undefined;
  if (
    network &&
    (typeof network.bindBeforeLaunch !== 'function' || typeof network.activateReady !== 'function')
  )
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  return constructEngine(
    configuration,
    Object.freeze({
      kind: 'serverOwned',
      owner,
      registerBirth,
      refuseBirth,
      network,
      input,
      capture,
      navigation,
    })
  );
}

/** One closure owns records, driver and both construction modes; no copied canonical Map. */
function constructEngine(
  configuration: unknown,
  construction: EngineConstruction
): BrowserLifecycleEngine {
  const validated = validateEngineConfiguration(configuration);
  const native = validated.nativeJournal
    ? createDarwinEngineProcesses(validated.nativeJournal.artifact)
    : null;
  const config = native ? { ...validated, processes: native.processes } : validated;
  if (
    config.network.kind === 'owned' &&
    (construction.kind !== 'serverOwned' || !construction.network)
  )
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const diagnosticsBudget = createDiagnosticsBudget();
  const records = new Map<string, BrowserRecord>();
  const generationReturns = new WeakMap<
    BrowserRecord,
    ReturnType<typeof createDarwinGenerationReturnOwner>
  >();
  const opening = new Set<Promise<OpenedResult>>();
  let stopping = false;
  let shutdownPromise: ReturnType<BrowserLifecycleEngine['shutdown']> | undefined;
  const find = (browserId: string, generation: number): BrowserRecord => {
    const record = records.get(browserId);
    if (!record || record.browserGeneration !== generation)
      throw new BrowserLifecycleError('STALE_BINDING');
    return record;
  };
  const close = (
    record: BrowserRecord,
    callerEnd?: number
  ): Promise<import('./lifecycle/records.js').CloseOutcome> => {
    return closeRecord(config, record, callerEnd);
  };
  const receiverFor = (record: BrowserRecord): PrivateBrowserRetirementReceiver => {
    const lifetime = record.lifetime;
    const generation = record.browserGeneration;
    const request = lifetime.requestRetirement;
    const observation = lifetime.ordinary.retirement.promise;
    const current = (): boolean =>
      Map.prototype.get.call(records, record.browserId) === record &&
      record.lifetime === lifetime &&
      record.browserGeneration === generation &&
      lifetime.ordinary.record === record &&
      lifetime.ordinary.records === records;
    const retire = (cause: 'disabled' | 'authorityRevoked' | 'persistenceFailure') => {
      if (!current()) throw new BrowserLifecycleError('STALE_BINDING');
      // Synchronous first-cause fence; the installed parent driver drains before terminal stop.
      Reflect.apply(request, lifetime, [cause]);
      return observation; // Same genuine owner promise, including sticky unverified outcomes.
    };
    return Object.freeze({
      browserId: record.browserId,
      browserGeneration: generation,
      acquisition: Object.freeze(
        record.mode === 'persistent'
          ? { mode: 'persistent' as const, profileId: record.profileId! }
          : { mode: 'ephemeral' as const }
      ),
      observation,
      isOrdinary: () => current() && ordinaryRecord(record),
      isAuthorityCurrent: () => currentAuthorityCustody(record, current),
      navigateInitial: (command: unknown) => navigateOwnedInitial(config, record, current, command),
      verifiedBrowserAdminEndpoint: () => {
        if (
          !current() ||
          !ordinaryRecord(record) ||
          lifetime.gate.stopped ||
          lifetime.uncertain ||
          !record.rootAttributed ||
          !record.root ||
          !record.supervisor ||
          !record.controllerBrowser ||
          !record.context ||
          record.supervisor.custody().uncertain ||
          !record.supervisor.custody().pending
        )
          return null;
        const endpoint = new URL(record.supervisor.reportedEndpointURL);
        return Object.freeze({
          url: `http://${endpoint.host}`,
          root: Object.freeze({ ...record.root }),
          supervisor: Object.freeze({
            ...record.supervisor.reportedSupervisor,
          }),
        });
      },
      verifiedRuntimeBinding: () =>
        current() && ordinaryRecord(record) && !lifetime.gate.stopped
          ? (record.verifiedRuntime ?? null)
          : null,
      disabled: () => retire('disabled'),
      authorityRevoked: () => retire('authorityRevoked'),
      persistenceFailure: () => retire('persistenceFailure'),
      generationReturned: () => generationReturns.get(record)?.completion ?? Promise.resolve(null),
      consumeGenerationReturn: (token: unknown, binding: DarwinGenerationBinding) =>
        current() && (generationReturns.get(record)?.consume(token, binding) ?? false),
    });
  };
  const result = async (
    record: BrowserRecord,
    requestId: string,
    callerEnd?: number
  ): Promise<Extract<BrowserResult, { kind: 'close' }>> =>
    parseBrowserResult({
      kind: 'close',
      requestId,
      browserId: record.browserId,
      browserGeneration: record.browserGeneration,
      ...(await close(record, callerEnd)),
    }) as Extract<BrowserResult, { kind: 'close' }>;
  const open = async (value: unknown): Promise<OpenedResult> => {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'open') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
    if (
      command.mode === 'persistent' &&
      [...records.values()].some(
        (record) => record.profileId === command.profileId && record.status !== 'stopped'
      )
    )
      throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
    const manager = native ? await native.identity(process.pid) : hostIdentity(process.pid);
    if (!manager) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    const browserId = parseBrowserId(randomBytes(16).toString('base64url'));
    const record: BrowserRecord = {
      diagnosticsBudget,
      browserId,
      lifetime: createBrowserLifetime(browserId, 0),
      browserGeneration: 0,
      mode: command.mode,
      ...(command.mode === 'persistent' ? { profileId: command.profileId } : {}),
      manager,
      launchEntered: false,
      rootAttributed: false,
      identities: [],
      inventoryComplete: false,
      status: 'opening',
      tabs: new Map(),
    };
    records.set(record.browserId, record);
    if (!bindOrdinaryRecord(record, records)) throw new BrowserLifecycleError('ENGINE_STOPPED');
    if (
      !installRetirementDriver(record, () => {
        void close(record).catch(() => {});
      })
    )
      throw new BrowserLifecycleError('ENGINE_STOPPED');
    let birthReceiver: PrivateBrowserRetirementReceiver | null = null;
    try {
      if (construction.kind === 'serverOwned') {
        birthReceiver = receiverFor(record);
        const returned = Reflect.apply(construction.registerBirth, construction.owner, [
          birthReceiver,
        ]);
        // Supported port is strictly synchronous void; never inspect/await arbitrary thenables.
        if (returned !== undefined) {
          record.lifetime.uncertain = true;
          throw new BrowserLifecycleError('ENGINE_STOPPED');
        }
        if (construction.navigation?.observeLifetime) {
          const observed = Reflect.apply(
            construction.navigation.observeLifetime,
            construction.navigation.owner,
            [birthReceiver]
          );
          if (observed !== undefined) throw new BrowserLifecycleError('ENGINE_STOPPED');
        }
        if (
          stopping ||
          !ordinaryRecord(record) ||
          record.lifetime.gate.stopped ||
          record.status !== 'opening' ||
          records.get(record.browserId) !== record
        )
          throw new BrowserLifecycleError('ENGINE_STOPPED');
      }
      await acquireBrowser(
        config,
        record,
        () =>
          stopping ||
          !ordinaryRecord(record) ||
          record.lifetime.gate.stopped ||
          record.status !== 'opening',
        construction.kind === 'serverOwned' && construction.network && birthReceiver
          ? async () => {
              const network = construction.network!;
              const peer = await Reflect.apply(network.bindBeforeLaunch, network.owner, [
                birthReceiver,
              ]);
              record.networkPeer = peer;
              const close = peer.close;
              record.networkClose = () => Reflect.apply(close, peer, []);
              if (
                !ordinaryRecord(record) ||
                record.lifetime.gate.stopped ||
                record.status !== 'opening'
              ) {
                record.lifetime.uncertain = true;
                record.networkClosePromise ??= ownOperation(record, async () => {
                  await record.networkClose!();
                  record.networkReturned = true;
                });
                void record.networkClosePromise.catch(() => {
                  record.lifetime.closeFailed = true;
                });
                throw new BrowserLifecycleError('ENGINE_STOPPED');
              }
              const custody = peer.isCustodyKnown;
              record.networkCustody = () => Reflect.apply(custody, peer, []) === true;
              const endpoint = new URL(peer.url);
              if (
                !Object.isFrozen(peer) ||
                endpoint.protocol !== 'http:' ||
                endpoint.hostname !== '127.0.0.1' ||
                !endpoint.port ||
                endpoint.origin !== peer.url ||
                typeof close !== 'function' ||
                typeof custody !== 'function' ||
                !peer.credentials ||
                peer.credentials.username !== 'dorkos' ||
                typeof peer.credentials.password !== 'string' ||
                peer.credentials.password.length < 1 ||
                peer.credentials.password.length > 4096
              )
                throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
              record.networkEndpoint = Object.freeze({
                url: peer.url,
                credentials: Object.freeze({ ...peer.credentials }),
              });
            }
          : undefined
      );
      // Generation returns belong to the opt-in native journal composition, not legacy fixtures.
      if (config.nativeJournal && record.reservation && !generationReturns.has(record)) {
        generationReturns.set(
          record,
          createDarwinGenerationReturnOwner(
            records,
            record,
            createHash('sha256').update(JSON.stringify(config.runtime)).digest('hex')
          )
        );
      }
      if (
        stopping ||
        !ordinaryRecord(record) ||
        record.status !== 'running' ||
        record.lifetime.gate.stopped
      )
        throw new BrowserLifecycleError('ENGINE_STOPPED');
      if (config.network.kind === 'owned') {
        if (
          construction.kind !== 'serverOwned' ||
          !construction.network ||
          !birthReceiver ||
          !record.networkPeer ||
          !birthReceiver.isAuthorityCurrent()
        )
          throw new BrowserLifecycleError('ENGINE_STOPPED');
        const network = construction.network;
        await ownOperation(record, () =>
          Reflect.apply(network.activateReady, network.owner, [birthReceiver, record.networkPeer])
        );
        if (!birthReceiver.isAuthorityCurrent()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      }
      const first = record.tabs.values().next().value;
      if (!first) throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
      if (!record.lifetime.inputs.get(first)?.ready)
        throw new BrowserLifecycleError('BROWSER_STOPPED');
      if (construction.kind === 'serverOwned' && construction.navigation?.continuation) {
        await installOwnerNavigation(
          config,
          record,
          first,
          () => !stopping && records.get(record.browserId) === record && ordinaryRecord(record),
          construction.navigation.continuation
        );
        if (!birthReceiver?.isAuthorityCurrent()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      }
      return parseBrowserResult({
        kind: 'opened',
        requestId: command.requestId,
        browserId: record.browserId,
        browserGeneration: record.browserGeneration,
        mode: record.mode,
        ...(record.profileId ? { profileId: record.profileId } : {}),
        tab: first.binding,
      }) as OpenedResult;
    } catch (error) {
      if (construction.kind === 'serverOwned' && birthReceiver !== null) {
        // Failed registration or acquisition closes local ordinary admission BEFORE server disposal.
        record.lifetime.requestRetirement('engineFault');
        try {
          const returned = Reflect.apply(construction.refuseBirth, construction.owner, [
            birthReceiver,
          ]);
          if (returned !== undefined) record.lifetime.uncertain = true;
        } catch {
          record.lifetime.uncertain = true;
        }
        // Disposal means revoke server admission only; custody stays retained through observation.
      }
      const originalCleanup =
        error instanceof BrowserLifecycleError ? error.cleanupCode : undefined;
      // A refused setup cleanup owns no returned reservation, but still requires quarantine.
      if (originalCleanup === 'PROFILE_UNCERTAIN') record.setupCleanupUncertain = true;
      const cleanup = await close(record);
      const primary = error instanceof BrowserLifecycleError ? error.code : 'OPEN_FAILED';
      throw new BrowserLifecycleError(
        primary,
        originalCleanup ?? (cleanup.cleanup === 'observed' ? undefined : cleanup.reason)
      );
    }
  };
  const captureOriginal = async (
    value: unknown,
    ownedWork?: OwnedCaptureWork
  ): Promise<BrowserCapture> => {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'capture') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    const record = find(command.binding.browserId, command.binding.browserGeneration);
    if (!ordinaryRecord(record) || initialNavigationPending(record))
      throw new BrowserLifecycleError('BROWSER_STOPPED');
    const tab = record.tabs.get(command.binding.tabId);
    if (tab && navigationPending(tab)) throw new BrowserLifecycleError('STALE_BINDING');
    const page = tab?.page;
    const capture = await ownOperation(record, () =>
      captureTab(config, record, command, ownedWork)
    ).catch((error: unknown) => {
      // The unchanged capture deadline bounds waiting, not an underlying Page effect.
      if (
        error instanceof BrowserLifecycleError &&
        (error.code === 'CAPTURE_TIMEOUT' || error.code === 'COUNTER_EXHAUSTED')
      ) {
        record.lifetime.uncertain = true;
        record.lifetime.requestRetirement('engineFault');
      }
      throw error;
    });
    if (
      !ordinaryRecord(record) ||
      !tab ||
      record.status !== 'running' ||
      tab.stopped ||
      tab.page !== page ||
      record.tabs.get(command.binding.tabId) !== tab ||
      record.lifetime.gate.stopped ||
      !sameBinding(tab.binding, command.binding)
    )
      throw new BrowserLifecycleError('STALE_BINDING');
    return capture;
  };
  const engine: BrowserLifecycleEngine = Object.freeze({
    open(command: unknown) {
      // Preregister a trusted native promise BEFORE open can enter external birth callbacks.
      const operation = Promise.resolve().then(() => open(command));
      opening.add(operation);
      void operation.then(
        () => opening.delete(operation),
        () => opening.delete(operation)
      );
      return operation;
    },
    listTabs(browserId: string, browserGeneration: number) {
      const record = find(browserId, browserGeneration);
      if (!ordinaryRecord(record) || record.status !== 'running')
        throw new BrowserLifecycleError('BROWSER_STOPPED');
      return Object.freeze(
        [...record.tabs.values()]
          .filter((tab) => !tab.stopped)
          .map((tab) => Object.freeze({ ...tab.binding }))
      );
    },
    capture(value: unknown) {
      if (construction.kind === 'serverOwned' && construction.capture)
        return Promise.reject(new BrowserLifecycleError('POLICY_REFUSED'));
      return captureOriginal(value);
    },
    input(value: unknown, signal?: AbortSignal) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'input') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      if (construction.kind === 'serverOwned' && construction.input)
        return Promise.resolve(
          Object.freeze({
            kind: 'action',
            requestId: command.requestId,
            binding: command.binding,
            outcome: 'rejected',
            reason: 'policyRefused',
          })
        );
      return submitInput(
        find(command.binding.browserId, command.binding.browserGeneration),
        command,
        signal
      );
    },
    resetInput(value: unknown) {
      const binding = parseBrowserBinding(value);
      return resetInput(find(binding.browserId, binding.browserGeneration), binding);
    },
    async close(value: unknown) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'close') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
      return result(find(command.browserId, command.browserGeneration), command.requestId);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      let resolve!: (value: readonly Extract<BrowserResult, { kind: 'close' }>[]) => void;
      shutdownPromise = new Promise((done) => {
        resolve = done;
      });
      stopping = true;
      for (const record of records.values()) fenceOrdinary(record, 'explicitStop');
      let end = 0;
      try {
        const entry = performance.now();
        if (Number.isFinite(entry) && entry >= 0) end = entry + 5000;
        else for (const record of records.values()) record.lifetime.uncertain = true;
      } catch {
        for (const record of records.values()) record.lifetime.uncertain = true;
      }
      const closing = [...records.values()].map((record) =>
        result(record, randomBytes(16).toString('base64url'), end)
      );
      void (async () => {
        await until(Promise.allSettled([...opening]), end, 'ENGINE_STOPPED').catch(() => {});
        // Every record close was entered before waiting for opening ownership; these share fixed ends.
        const outcomes = await Promise.all(closing);
        resolve(Object.freeze(outcomes));
      })();
      return shutdownPromise;
    },
  });
  if (construction.kind === 'serverOwned' && construction.input) {
    const issuer = createOwnedInputIssuer();
    const dispatcher: PrivateBrowserInputDispatcher = Object.freeze({
      input(value: unknown, authorization: OwnedInputAuthorization, signal?: AbortSignal) {
        const command = parseBrowserCommand(value);
        if (command.kind !== 'input') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
        if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
        const token = issuer.issue(command, authorization);
        try {
          const operation = submitInput(
            find(command.binding.browserId, command.binding.browserGeneration),
            command,
            signal,
            token
          );
          return operation.finally(() => issuer.invalidate(token));
        } catch (error) {
          issuer.invalidate(token);
          throw error;
        }
      },
    });
    Reflect.apply(construction.input.registerDispatcher, construction.input.owner, [dispatcher]);
  }
  if (construction.kind === 'serverOwned' && construction.capture) {
    const issuer = createOwnedCaptureIssuer();
    const dispatcher: PrivateBrowserCaptureDispatcher = Object.freeze({
      capture(value: unknown, authorization: OwnedCaptureAuthorization) {
        if (stopping) throw new BrowserLifecycleError('ENGINE_STOPPED');
        const token = issuer.issue(value, authorization);
        return captureOriginal(value, token).finally(() => issuer.invalidate(token));
      },
    });
    Reflect.apply(construction.capture.registerDispatcher, construction.capture.owner, [
      dispatcher,
    ]);
  }
  if (construction.kind === 'serverOwned' && construction.navigation) {
    const issuer = createOwnedNavigationIssuer();
    const dispatcher: PrivateBrowserNavigationDispatcher = Object.freeze({
      navigate(value: unknown, authorization: OwnedNavigationAuthorization, signal?: AbortSignal) {
        const command = parseBrowserCommand(value);
        if (command.kind !== 'navigate') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
        if (stopping || signal?.aborted) throw new BrowserLifecycleError('ENGINE_STOPPED');
        const token = issuer.issue(command, authorization);
        try {
          const record = find(command.binding.browserId, command.binding.browserGeneration);
          const lifetime = record.lifetime;
          const generation = record.browserGeneration;
          const current = () =>
            !stopping &&
            Map.prototype.get.call(records, record.browserId) === record &&
            record.lifetime === lifetime &&
            record.browserGeneration === generation &&
            lifetime.ordinary.record === record &&
            lifetime.ordinary.records === records;
          return navigateOwned(config, record, current, command, token, signal).finally(() =>
            issuer.invalidate(token)
          );
        } catch (error) {
          issuer.invalidate(token);
          throw error;
        }
      },
    });
    Reflect.apply(construction.navigation.registerDispatcher, construction.navigation.owner, [
      dispatcher,
    ]);
  }
  return engine;
}
