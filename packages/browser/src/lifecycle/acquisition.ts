import { readControllerOriginalCatalog } from '../runtime/identity/controller-original-catalog.js';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { createSupervisorProtocolWire } from '../runtime/identity/supervisor-protocol-wire.js';
import { createControllerProxyAuthentication } from '../runtime/identity/controller-proxy-authentication.js';
import { captureOriginalSupervisorCloseDiagnostic } from './supervisor-close-diagnostic.js';
import { ownCrashRetirement, noteOriginalRootFailure } from '../runtime/crash-custody.js';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';
import { sameProcess } from './process-journal.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { startDarwinEngineJournal } from '../runtime/darwin-engine-journal.js';
import { privateDirectory } from '../profiles/paths.js';
import { ordinaryRecord } from './ownership.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import { verifiedLibrary } from '../runtime/public-library.js';
import { nativeHolder } from '../runtime/host-identity.js';
import { ownDirectory, assertDirectory } from '../profiles/owned-directory.js';
import { prepareDataRoot } from '../profiles/paths.js';
import { reserveProfile } from '../profiles/reservation.js';
import { startFixtureProxy } from '../network/fixture-proxy.js';
import { trackPage, isOriginalTabLimitRefusal } from '../tabs/registry.js';
import type { BrowserRecord } from './records.js';
import { BrowserLifecycleError } from './errors.js';
import { deadline } from './deadline.js';
import { completeInventory } from './inventory.js';
import { ownOperation, acceptContext, closeOwned } from './ownership.js';
import { composeInput } from './input-owner.js';

/** Private baseline descriptor; pinned library/executable remain exact and verifier stays native-only. */
export function nativeRuntimeForAcquisition(
  runtime: BrowserRuntimeDescriptor
): BrowserRuntimeDescriptor {
  return runtime.identity.mode === 'native'
    ? runtime
    : Object.freeze({
        ...runtime,
        identity: Object.freeze({ ...runtime.identity, mode: 'native' as const }),
      });
}

async function attributeRoot(
  config: EngineConfiguration,
  record: BrowserRecord,
  stopped: () => boolean
): Promise<void> {
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const native = config.nativeJournal
    ? createDarwinEngineProcesses(config.nativeJournal.artifact)
    : null;
  const root = await ownOperation(record, () =>
    native ? native.holder(record.profileDir!) : nativeHolder(record.profileDir!)
  );
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (!root) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  record.root = root;
  const abort = new AbortController();
  try {
    if (
      native &&
      !(await ownOperation(record, () =>
        native.attributeRoot(record.supervisor?.reportedSupervisor ?? record.manager, root)
      ))
    )
      throw new BrowserLifecycleError('PROCESS_ATTRIBUTION_UNAVAILABLE');
    if (native && record.supervisor) {
      const supervisor = record.supervisor.reportedSupervisor;
      if (
        !sameProcess(root, record.supervisor.reportedRoot) ||
        !(await ownOperation(record, () => native.attributeRoot(record.manager, supervisor)))
      )
        throw new BrowserLifecycleError('PROCESS_ATTRIBUTION_UNAVAILABLE');
    }
    const tree = await deadline(
      ownOperation(record, () => {
        const observe = config.processes.descendants;
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        return Reflect.apply(observe, config.processes, [
          native ? root : record.manager,
          abort.signal,
        ]) as ReturnType<typeof observe>;
      }),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
    completeInventory(tree, root);
    const observed = await deadline(
      ownOperation(record, () => {
        const observe = config.processes.observe;
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        return Reflect.apply(observe, config.processes, [root, abort.signal]) as ReturnType<
          typeof observe
        >;
      }),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
    if (observed.status !== 'alive')
      throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    if (record.journal)
      await ownOperation(record, () =>
        record.journal!.attributeRoot(root, record.supervisor?.reportedSupervisor)
      );
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    record.rootAttributed = true;
    await ownOperation(record, () => {
      const reservation = record.reservation;
      const publish = reservation?.recordBrowser;
      if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      if (reservation) Reflect.apply(publish!, reservation, [root]);
    });
  } finally {
    abort.abort();
  }
}

/** Acquire only an exact native fixture browser; the caller owns this ledger before entry. */
export async function acquireBrowser(
  config: EngineConfiguration,
  record: BrowserRecord,
  cancelled: () => boolean,
  bindNetwork?: () => Promise<void>,
  originalChild?: NonNullable<Parameters<typeof startDarwinSupervisorClient>[3]>
): Promise<void> {
  if (config.network.kind === 'fixture' && new URL(config.network.origin).protocol !== 'http:')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  if (!record.diagnosticsBudget) throw new Error('DIAGNOSTIC_OWNERSHIP_UNAVAILABLE');
  const originalRuntime = config.runtime;
  if (
    originalRuntime.identity.mode === 'chrome-compatible' &&
    !config.nativeJournal?.browserWorkerPath
  )
    throw new BrowserLifecycleError('IDENTITY_MODE_UNAVAILABLE');
  const nativeRuntime = nativeRuntimeForAcquisition(originalRuntime);
  const diagnosticNow = config.clock.monotonicNow.bind(config.clock);
  const stopped = () =>
    !ordinaryRecord(record) ||
    cancelled() ||
    record.status !== 'opening' ||
    record.lifetime.gate.stopped;
  const chromium = await deadline(
    ownOperation(record, () => verifiedLibrary(nativeRuntime)),
    10_000,
    'RUNTIME_UNAVAILABLE'
  );
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (config.network.kind === 'owned')
    record.verifiedRuntime = Object.freeze({
      runtimeIdentity: createHash('sha256').update(JSON.stringify(originalRuntime)).digest('hex'),
      policyRevision: config.network.policyRevision,
    });
  const root = await ownOperation(record, () => prepareDataRoot(config.dataDir));
  if (stopped()) {
    record.lifetime.uncertain = true;
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  }
  await ownOperation(
    record,
    () => ownDirectory(root),
    (directory) => {
      record.dataRoot = directory;
    }
  );
  if (stopped()) {
    record.lifetime.uncertain = true;
    throw new BrowserLifecycleError('ENGINE_STOPPED');
  }
  if (record.profileId) {
    await ownOperation(
      record,
      () => reserveProfile(config, root, record.profileId!, record.manager),
      (reservation) => {
        record.reservation = reservation;
        if (stopped()) record.lifetime.uncertain = true;
      }
    );
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    record.profileDir = record.reservation!.profileDir;
  } else
    await ownOperation(
      record,
      () => mkdtemp(join(root, 'ephemeral', 'clean-')),
      (path) => {
        record.profileDir = path;
        if (stopped()) record.lifetime.uncertain = true;
      }
    );
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  await ownOperation(
    record,
    () => ownDirectory(record.profileDir!),
    (directory) => {
      record.directory = directory;
      if (stopped()) record.lifetime.uncertain = true;
    }
  );
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (config.network.kind === 'owned') {
    if (!bindNetwork) throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
    await deadline(ownOperation(record, bindNetwork), 10_000, 'NETWORK_BIND_TIMEOUT');
    if (stopped() || !record.networkEndpoint || record.networkCustody?.() !== true)
      throw new BrowserLifecycleError('ENGINE_STOPPED');
  }
  if (config.network.kind === 'fixture' && !config.nativeJournal?.browserWorkerPath)
    await ownOperation(
      record,
      () => startFixtureProxy(config.network.origin),
      (proxy) => {
        record.proxy = proxy;
        if (stopped()) {
          record.lifetime.uncertain = true;
          void closeOwned(record, 'proxy', proxy).catch(() => {});
        }
      }
    ).catch((error: unknown) => {
      record.lifetime.uncertain = true;
      throw error;
    });
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  assertDirectory(record.dataRoot!);
  assertDirectory(record.directory!);
  const reservationNonce = record.reservation?.nonce ?? randomUUID();
  if (config.nativeJournal) {
    const journals = join(root, 'journals');
    await ownOperation(record, () => privateDirectory(journals));
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    await ownOperation(
      record,
      () =>
        startDarwinEngineJournal({
          ...config.nativeJournal!,
          parentDirectory: journals,
          binding: {
            journalId: randomUUID(),
            browserId: record.browserId,
            browserGeneration: record.browserGeneration,
            reservationNonce,
            profile: record.profileId
              ? { kind: 'persistent', profileId: record.profileId }
              : { kind: 'ephemeral' },
            manager: record.manager,
            runtimeIdentityDigest: createHash('sha256')
              .update(JSON.stringify(originalRuntime))
              .digest('hex'),
          },
        }),
      (journal) => {
        record.journal = journal;
      }
    );
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    if (record.reservation) record.reservation.recordJournal(record.journal!.binding);
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  }
  const begin = record.reservation?.beginLaunch;
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (record.reservation) Reflect.apply(begin!, record.reservation, []);
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (config.network.kind === 'owned' && !config.nativeJournal?.browserWorkerPath)
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  record.launchEntered = true;
  if (config.nativeJournal?.browserWorkerPath) {
    const originalJournal = record.journal;
    const originalRootReturned = originalJournal?.rootReturned?.bind(originalJournal);
    if (!originalRootReturned) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    await ownOperation(
      record,
      () =>
        startDarwinSupervisorClient(
          {
            launcher: config.nativeJournal!.launcher,
            workerPath: config.nativeJournal!.browserWorkerPath!,
            artifact: config.nativeJournal!.artifact,
            runtime: originalRuntime,
            // Reuse the SAME native descriptor already consumed by the strict verifier.
            ...(originalRuntime.identity.mode === 'chrome-compatible'
              ? { identityPreparation: { nativeRuntime } }
              : {}),
            manager: record.manager,
            profileDir: record.profileDir!,
            origin: config.network.origin,
            ...(record.networkEndpoint ? { ownedProxy: record.networkEndpoint } : {}),
            browserId: record.browserId,
            generation: record.browserGeneration,
            reservationNonce,
          },
          () => noteOriginalRootFailure(record),
          (root) => ownOperation(record, () => originalRootReturned(root)),
          originalChild
        ),
      (supervisor) => {
        record.supervisor = supervisor;
        const diagnoseClose = captureOriginalSupervisorCloseDiagnostic(supervisor);
        // The proxy is an exact supervisor-owned lifetime, not a second controller listener.
        record.proxy = Object.freeze({
          url: supervisor.reportedProxyURL,
          close: async () => {
            await record.supervisorStopBarrier;
            let result: Awaited<ReturnType<typeof supervisor.close>>;
            try {
              result = await supervisor.close();
            } catch (value) {
              diagnoseClose();
              throw value;
            }
            if (result.pending || result.uncertain) {
              const failure = new Error('SUPERVISOR_CLOSE_UNCERTAIN');
              diagnoseClose();
              throw failure;
            }
            diagnoseClose();
          },
        });
        if (stopped()) {
          record.lifetime.uncertain = true;
          void closeOwned(record, 'proxy', record.proxy).catch(() => {});
        }
      }
    );
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    // Native chain and durable journal enrollment precede the controller CDP attachment.
    await attributeRoot(config, record, stopped);
  }
  const acquired = ownOperation(
    record,
    async () => {
      if (record.supervisor) {
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        let closeOriginalController: (() => Promise<void>) | undefined;
        try {
          let endpoint: string | ConnectOverCDPTransport = record.supervisor.reportedEndpointURL;
          if (config.network.kind === 'owned') {
            const peer = record.networkEndpoint;
            const custody = record.networkCustody?.bind(record);
            if (!peer || !custody) throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
            // Retain the original attributed wire before adapter construction or SDK acquisition.
            // The same record owns cleanup even when either producer fails or returns late.
            const wire = createSupervisorProtocolWire(record.supervisor.reportedEndpointURL);
            record.controllerWire = wire;
            closeOriginalController = wire.close.bind(wire);
            await ownOperation(record, wire.open.bind(wire));
            if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
            const originalCatalog = await ownOperation(record, () =>
              readControllerOriginalCatalog(wire.transport)
            );
            if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
            const locallyCurrent = () =>
              ordinaryRecord(record) &&
              (record.status !== 'opening' || !cancelled()) &&
              !record.lifetime.gate.stopped &&
              !record.lifetime.uncertain &&
              !record.closePromise &&
              (record.status === 'opening' || record.status === 'running') &&
              record.controllerWire === wire &&
              wire.isKnown() &&
              record.networkEndpoint === peer;
            const authentication = createControllerProxyAuthentication(
              wire.transport,
              peer,
              () => locallyCurrent() && custody() === true && locallyCurrent(),
              () => {
                record.lifetime.uncertain = true;
                record.lifetime.requestRetirement('engineFault');
              },
              originalCatalog
            );
            record.controllerAuthentication = authentication;
            closeOriginalController = authentication.close.bind(authentication);
            endpoint = authentication.transport;
          }
          const connectOptions = { timeout: 10000, noDefaults: true };
          const browser =
            typeof endpoint === 'string'
              ? await chromium.connectOverCDP(endpoint, connectOptions)
              : await chromium.connectOverCDP(endpoint, connectOptions);
          record.controllerBrowser = browser;
          if (stopped()) {
            record.lifetime.uncertain = true;
            await browser.close();
            throw new BrowserLifecycleError('ENGINE_STOPPED');
          }
          // The sole supervisor deny owner is initialized before its ready publication.
          // Suppress SDK defaults without creating a second context override owner.
          const contexts = browser.contexts();
          if (contexts.length !== 1) throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
          const context = contexts[0]!;
          for (const page of context.pages())
            await page.setViewportSize({ width: 1280, height: 720 });
          return context;
        } catch (value) {
          // Acquisition remains owned while its captured late/failing wire is joined.
          // A prior parent close may have inspected the record before this original returned.
          if (closeOriginalController) {
            try {
              await ownOperation(record, closeOriginalController);
            } catch {
              record.lifetime.uncertain = true;
            }
          }
          throw value;
        }
      }
      const launch = chromium.launchPersistentContext;
      if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      return Reflect.apply(launch, chromium, [
        record.profileDir!,
        {
          executablePath: config.runtime.executable.path,
          headless: true,
          chromiumSandbox: true,
          acceptDownloads: false,
          viewport: { width: 1280, height: 720 },
          timeout: 10_000,
          proxy: { server: record.proxy!.url, bypass: '<-loopback>' },
          args: ['--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp'],
        },
      ]) as ReturnType<typeof launch>;
    },
    (context) => acceptContext(record, context)
  );
  const context = await deadline(acquired, 10_000, 'BROWSER_LAUNCH_TIMEOUT');
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (record.supervisor) ownCrashRetirement(record, context);
  if (!record.supervisor) await attributeRoot(config, record, stopped);
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const register = (
    event: 'page' | 'close',
    callback: ((page: import('playwright-core').Page) => void) | (() => void)
  ) =>
    ownOperation(record, () => {
      const on = context.on;
      if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      Reflect.apply(on, context, [event, callback]);
    });
  await register('page', (page: import('playwright-core').Page) => {
    if (!ordinaryRecord(record)) {
      // Context custody still owns this late Page. No ordinary registration or completeness claim.
      record.lifetime.uncertain = true;
      return;
    }
    try {
      const tab = trackPage(record, page, config.network.origin, diagnosticNow, context);
      if (ordinaryRecord(record) && record.status === 'running' && !record.lifetime.gate.stopped) {
        try {
          composeInput(config, record, tab);
        } catch {
          record.lifetime.requestRetirement('engineFault');
        }
      }
    } catch (value) {
      // The registration producer already fenced and entered original retirement.
      if (!isOriginalTabLimitRefusal(value)) throw value;
    }
  });
  await register('close', () => {
    record.lifetime.requestRetirement('engineFault');
  });
  const pages = await ownOperation(record, () => {
    const list = context.pages;
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    return Reflect.apply(list, context, []) as ReturnType<typeof list>;
  });
  for (const page of pages) trackPage(record, page, config.network.origin, diagnosticNow);
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const first =
    record.tabs.values().next().value ??
    trackPage(
      record,
      await ownOperation(record, () => {
        const create = context.newPage;
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        return Reflect.apply(create, context, []) as ReturnType<typeof create>;
      }),
      config.network.origin,
      diagnosticNow
    );
  try {
    first.initialNavigation = true;
    if (config.network.kind === 'fixture')
      await ownOperation(record, () => {
        const goto = first.page.goto;
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        return Reflect.apply(goto, first.page, [config.network.origin]) as ReturnType<typeof goto>;
      });
  } catch {
    throw new BrowserLifecycleError('INITIAL_NAVIGATION_FAILED');
  } finally {
    first.initialNavigation = false;
  }
  if (stopped() || first.stopped) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const input = composeInput(config, record, first);
  await input.readiness;
  if (stopped() || !input.ready) throw new BrowserLifecycleError('ENGINE_STOPPED');
  record.status = 'running';
  for (const tab of record.tabs.values())
    if (tab !== first && !tab.stopped) composeInput(config, record, tab);
}
