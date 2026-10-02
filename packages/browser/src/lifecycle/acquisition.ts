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
import { closeRecord } from './close.js';

async function attributeRoot(config: EngineConfiguration, record: BrowserRecord): Promise<void> {
  const root = nativeHolder(record.profileDir!);
  if (!root) throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  record.root = root;
  const abort = new AbortController();
  try {
    const tree = await deadline(
      config.processes.descendants(record.manager, abort.signal),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
    completeInventory(tree, root);
    const observed = await deadline(
      config.processes.observe(root, abort.signal),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
    if (observed.status !== 'alive')
      throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
    record.rootAttributed = true;
    record.reservation?.recordBrowser(root);
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
  const chromium = await deadline(verifiedLibrary(config.runtime), 10_000, 'RUNTIME_UNAVAILABLE');
  if (cancelled()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  const root = prepareDataRoot(config.dataDir);
  record.dataRoot = ownDirectory(root);
  if (record.profileId) {
    record.reservation = await reserveProfile(config, root, record.profileId, record.manager);
    record.profileDir = record.reservation.profileDir;
  } else record.profileDir = await mkdtemp(join(root, 'ephemeral', 'clean-'));
  record.directory = ownDirectory(record.profileDir);
  record.proxy = await startFixtureProxy(config.network.origin);
  if (cancelled()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  assertDirectory(record.dataRoot);
  assertDirectory(record.directory);
  record.reservation?.beginLaunch();
  record.launchEntered = true;
  let abandoned = false;
  const launching = chromium.launchPersistentContext(record.profileDir, {
    executablePath: config.runtime.executable.path,
    headless: true,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 720 },
    timeout: 10_000,
    proxy: { server: record.proxy.url, bypass: '<-loopback>' },
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  // Register ownership before awaiting launch: a late public context can never escape the ledger.
  const acquired = launching.then((context) => {
    record.context = context;
    if (abandoned) {
      record.closePromise = (async () => {
        try {
          await attributeRoot(config, record);
        } catch {
          /* Unknown attribution remains quarantined. */
        }
        return closeRecord(config, record);
      })();
    }
    return context;
  });
  let context;
  try {
    context = await deadline(acquired, 10_000, 'BROWSER_LAUNCH_TIMEOUT');
  } catch (error) {
    abandoned = true;
    throw error;
  }
  await attributeRoot(config, record);
  if (cancelled()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  context.on('page', (page) => trackPage(record, page, config.network.origin));
  context.on('close', () => {
    for (const tab of record.tabs.values()) tab.stopped = true;
  });
  for (const page of context.pages()) trackPage(record, page, config.network.origin);
  const first =
    record.tabs.values().next().value ??
    trackPage(record, await context.newPage(), config.network.origin);
  try {
    await first.page.goto(config.network.origin);
  } catch {
    throw new BrowserLifecycleError('INITIAL_NAVIGATION_FAILED');
  }
  if (cancelled() || first.stopped) throw new BrowserLifecycleError('ENGINE_STOPPED');
  record.status = 'running';
}
