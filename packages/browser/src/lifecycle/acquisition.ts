import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineConfiguration } from '../configuration.js';
import { verifiedLibrary } from '../runtime/public-library.js';
import { nativeHolder } from '../runtime/host-identity.js';
import { ownDirectory, assertDirectory } from '../profiles/owned-directory.js';
import { prepareDataRoot } from '../profiles/paths.js';
import { reserveProfile } from '../profiles/reservation.js';
import { startFixtureProxy } from '../network/fixture-proxy.js';
import { trackPage } from '../tabs/registry.js';
import type { BrowserRecord } from './records.js';
import { BrowserLifecycleError } from './errors.js';
import { deadline } from './deadline.js';
import { completeInventory } from './inventory.js';
import { ownOperation, acceptContext, closeOwned } from './ownership.js';
import { composeInput } from './input-owner.js';

async function attributeRoot(
  config: EngineConfiguration,
  record: BrowserRecord,
  stopped: () => boolean
): Promise<void> {
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const root = await ownOperation(record, () => nativeHolder(record.profileDir!));
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (!root) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  record.root = root;
  const abort = new AbortController();
  try {
    const tree = await deadline(
      ownOperation(record, () => {
        const observe = config.processes.descendants;
        if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
        return Reflect.apply(observe, config.processes, [
          record.manager,
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
  cancelled: () => boolean
): Promise<void> {
  if (new URL(config.network.origin).protocol !== 'http:')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const stopped = () => cancelled() || record.status !== 'opening' || record.lifetime.gate.stopped;
  const chromium = await deadline(
    ownOperation(record, () => verifiedLibrary(config.runtime)),
    10_000,
    'RUNTIME_UNAVAILABLE'
  );
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
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
  const begin = record.reservation?.beginLaunch;
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  if (record.reservation) Reflect.apply(begin!, record.reservation, []);
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  record.launchEntered = true;
  const acquired = ownOperation(
    record,
    () => {
      const launch = chromium.launchPersistentContext;
      if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      return Reflect.apply(launch, chromium, [
        record.profileDir!,
        {
          executablePath: config.runtime.executable.path,
          headless: true,
          chromiumSandbox: true,
          viewport: { width: 1280, height: 720 },
          timeout: 10_000,
          proxy: { server: record.proxy!.url, bypass: '<-loopback>' },
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        },
      ]) as ReturnType<typeof launch>;
    },
    (context) => acceptContext(record, context)
  );
  const context = await deadline(acquired, 10_000, 'BROWSER_LAUNCH_TIMEOUT');
  if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  await attributeRoot(config, record, stopped);
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
    const tab = trackPage(record, page, config.network.origin);
    if (record.status === 'running' && !record.lifetime.gate.stopped) {
      try {
        composeInput(config, record, tab);
      } catch {
        record.lifetime.retire?.();
      }
    }
  });
  await register('close', () => {
    record.lifetime.gate.stop();
    record.lifetime.retire?.();
  });
  const pages = await ownOperation(record, () => {
    const list = context.pages;
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
    return Reflect.apply(list, context, []) as ReturnType<typeof list>;
  });
  for (const page of pages) trackPage(record, page, config.network.origin);
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
      config.network.origin
    );
  try {
    first.initialNavigation = true;
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
