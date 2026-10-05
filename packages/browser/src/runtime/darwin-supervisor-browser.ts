import { ownPrivateProxyAuthentication } from './private-proxy-auth.js';
import { constants } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import type { ProcessIdentity, ProcessTreeObservation } from '../configuration.js';
import { verifiedLibrary } from './public-library.js';
import { startFixtureProxy, type FixtureProxy } from '../network/fixture-proxy.js';
import {
  createDarwinOwnedChildLauncher,
  acceptsDarwinOwnedChildReturn,
  type DarwinOwnedChild,
} from './darwin-owned-child.js';
import { createDarwinEngineProcesses } from './darwin-engine-processes.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import { ownDirectory, assertDirectory, type OwnedDirectory } from '../profiles/owned-directory.js';

type State = {
  directory: OwnedDirectory;
  child?: DarwinOwnedChild;
  browser?: Browser;
  proxy?: FixtureProxy;
  auth?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>>;
  uncertain: boolean;
  cleanup?: Promise<unknown>;
};
const retained = new Set<State>();
const endpointReads = new Set<FileHandle>();
let endpointUncertain = false;
async function waitWithin<T>(original: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      original,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SUPERVISOR_WAIT_EXPIRED')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Bounded endpoint record; URLs from requests or Chromium stderr never select the peer. */
export function parseOwnedDevToolsEndpoint(bytes: Uint8Array): string {
  if (bytes.byteLength > 1024) throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^([1-9][0-9]{0,4})\n(\/devtools\/browser\/[a-fA-F0-9-]{36})\n?$/.exec(value);
  if (!match || Number(match[1]) > 65535) throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
  return `ws://127.0.0.1:${match[1]}${match[2]}`;
}
async function endpoint(
  file: string,
  before: string | null,
  directory: OwnedDirectory
): Promise<string> {
  assertDirectory(directory);
  const original = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  endpointReads.add(original);
  let failed = false,
    primary: unknown,
    result = '';
  try {
    const first = await original.stat({ bigint: true });
    if (!first.isFile() || first.size > 1024n || first.uid !== BigInt(process.getuid!()))
      throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
    const fingerprint = `${first.dev}:${first.ino}:${first.size}:${first.mtimeNs}:${first.ctimeNs}`;
    if (fingerprint === before) throw new Error('DEVTOOLS_ENDPOINT_STALE');
    const bytes = new Uint8Array(1025);
    const read = await original.read(bytes, 0, bytes.length, 0);
    const after = await original.stat({ bigint: true }),
      named = await lstat(file, { bigint: true });
    for (const stat of [after, named])
      if (
        !stat.isFile() ||
        stat.dev !== first.dev ||
        stat.ino !== first.ino ||
        stat.size !== first.size ||
        stat.mtimeNs !== first.mtimeNs ||
        stat.ctimeNs !== first.ctimeNs
      )
        throw new Error('DEVTOOLS_ENDPOINT_CHANGED');
    if (read.bytesRead !== Number(first.size)) throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
    assertDirectory(directory);
    result = parseOwnedDevToolsEndpoint(bytes.subarray(0, read.bytesRead));
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await original.close();
    endpointReads.delete(original);
  } catch (error) {
    endpointUncertain = true;
    throw Object.assign(new Error('DEVTOOLS_CLOSE_UNCERTAIN', { cause: error }), {
      primaryReadFailure: failed ? primary : null,
    });
  }
  if (failed) throw primary;
  return result;
}

/** Supported CDP composition: supervisor owns the actual original Chromium child and both pipes. */
export async function launchDarwinSupervisorBrowser(
  options: Readonly<{
    manager: ProcessIdentity;
    runtime: BrowserRuntimeDescriptor;
    artifact: Readonly<{ path: string; sha256: string }>;
    profileDir: string;
    origin: string;
    ownedProxy?: Readonly<{
      url: string;
      credentials: Readonly<{ username: string; password: string }>;
    }>;
  }>,
  failed: () => void = () => {}
) {
  if (endpointUncertain) throw new Error('DEVTOOLS_CLOSE_UNCERTAIN');
  const directory = ownDirectory(options.profileDir);
  for (const original of retained)
    if (
      original.directory.path === directory.path ||
      (original.directory.dev === directory.dev && original.directory.ino === directory.ino)
    )
      throw new Error('SUPERVISOR_PROFILE_UNCERTAIN');
  // Registration is synchronous, before any metadata/library acquisition or await.
  const state: State = { directory, uncertain: false };
  retained.add(state);
  const processes = createDarwinEngineProcesses(options.artifact);
  const file = join(options.profileDir, 'DevToolsActivePort');
  let before: string | null = null;
  let root: ProcessIdentity;
  let supervisor: ProcessIdentity;
  let endpointURL: string;
  try {
    const chromium = await verifiedLibrary(options.runtime);
    try {
      const stat = await lstat(file, { bigint: true });
      if (!stat.isFile() || stat.size > 1024n || stat.uid !== BigInt(process.getuid!()))
        throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
      before = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!options.ownedProxy) state.proxy = await startFixtureProxy(options.origin);
    assertDirectory(directory);
    state.child = await createDarwinOwnedChildLauncher({
      artifact: options.artifact,
      manager: options.manager,
    }).launch({
      executable: options.runtime.executable.path,
      cwd: options.profileDir,
      env: { PATH: '/usr/bin:/bin', HOME: options.profileDir, LANG: 'C', LC_ALL: 'C' },
      argv: [
        '--headless=new',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // Match relevant public launch defaults of the verified pinned library.
        '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints',
        '--disable-field-trial-config',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-back-forward-cache',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--no-service-autorun',
        '--metrics-recording-only',
        '--force-color-profile=srgb',
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${options.profileDir}`,
        `--proxy-server=${options.ownedProxy?.url ?? state.proxy!.url}`,
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        'about:blank',
      ],
    });
    root = await state.child.identity();
    const end = performance.now() + 10000;
    let url: string | undefined;
    while (performance.now() < end) {
      try {
        url = await endpoint(file, before, directory);
        break;
      } catch (error) {
        if (error instanceof Error && error.message === 'DEVTOOLS_CLOSE_UNCERTAIN') throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!url) throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
    endpointURL = url;
    const holder = await processes.holder(options.profileDir);
    assertDirectory(directory);
    if (!holder || !sameProcess(holder, root)) throw new Error('DEVTOOLS_ROOT_MISMATCH');
    const sender = await processes.identity(process.pid);
    if (!sender) throw new Error('SUPERVISOR_IDENTITY_UNAVAILABLE');
    supervisor = sender;
    if (options.ownedProxy)
      state.auth = await ownPrivateProxyAuthentication(url, options.ownedProxy, () => {
        state.uncertain = true;
        failed();
      });
    state.browser = await chromium.connectOverCDP(url, {
      timeout: Math.max(1, end - performance.now()),
    });
    if (state.browser.contexts().length !== 1) throw new Error('PERSISTENT_CONTEXT_UNAVAILABLE');
  } catch (error) {
    state.uncertain = true;
    // Failure remains retained; request cooperative stop of the actual original only.
    try {
      state.child?.child.kill('SIGTERM');
    } catch {
      /* Original custody remains retained. */
    }
    state.cleanup = Promise.allSettled([
      Promise.resolve().then(() => state.browser?.close()),
      Promise.resolve().then(() => state.proxy?.close()),
      Promise.resolve().then(() => state.auth?.close()),
      Promise.resolve().then(() => state.child?.completion()),
    ]);
    await waitWithin(state.cleanup, 2000).catch(() => {});
    throw error;
  }
  const browser = state.browser,
    child = state.child,
    proxy = state.proxy;
  const context: BrowserContext = browser.contexts()[0]!;
  let closing: Promise<boolean> | undefined;
  return Object.freeze({
    context,
    root,
    child,
    supervisor,
    proxyURL: options.ownedProxy?.url ?? proxy!.url,
    endpointURL,
    close() {
      if (closing) return closing;
      const original = (async () => {
        const abort = new AbortController();
        let tree: ProcessTreeObservation = { status: 'unknown', identities: [] };
        try {
          tree = await processes.processes.descendants(root, abort.signal);
        } catch {
          state.uncertain = true;
        }
        if (tree.status !== 'complete') state.uncertain = true;
        const results = await Promise.allSettled([
          (async () => {
            const session = await browser.newBrowserCDPSession();
            await session.send('Browser.close');
          })(),
          Promise.resolve().then(() => proxy?.close()),
          Promise.resolve().then(() => state.auth?.close()),
        ]);
        for (const result of results)
          if (result.status === 'rejected')
            process.stderr.write(
              'SUPERVISOR_CLOSE: ' +
                String(
                  result.reason instanceof Error ? result.reason.message.slice(0, 1024) : 'unknown'
                ) +
                '\n'
            );
        if (results.some((result) => result.status === 'rejected')) state.uncertain = true;
        const returned = await child.returned();
        if (!returned)
          process.stderr.write(
            'SUPERVISOR_CHILD_RETURN: ' + String(child.custody().firstCause) + '\n'
          );
        let statuses: { status: 'alive' | 'dead' | 'unknown' }[] = [];
        const nativeEnd = performance.now() + 2000;
        try {
          do {
            statuses = await Promise.all(
              tree.identities.map((identity) => processes.observeTerminated(identity, abort.signal))
            );
            if (statuses.length && statuses.every((value) => value.status === 'dead')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } while (performance.now() < nativeEnd);
        } catch {
          state.uncertain = true;
        }
        try {
          await browser.close();
        } catch {
          state.uncertain = true;
        }
        abort.abort();
        if (
          !returned ||
          !acceptsDarwinOwnedChildReturn(child, returned) ||
          !statuses.length ||
          statuses.some((value) => value.status !== 'dead')
        )
          state.uncertain = true;
        if (!state.uncertain) retained.delete(state);
        return !state.uncertain;
      })();
      state.cleanup = original; // The deadline never relinquishes the actual originals or operation.
      closing = waitWithin(original, 5000).catch(() => {
        state.uncertain = true;
        return false;
      });
      return closing;
    },
  });
}
