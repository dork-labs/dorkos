import { classifyOriginalWireRetirement } from './identity/supervisor-wire-retirement.js';
import {
  createSupervisorUncertaintyDiagnostic,
  createOriginalClosePendingDiagnostic,
  type SupervisorUncertaintyCode,
} from './supervisor-uncertainty-diagnostic.js';
import { consumeSupervisorIdentityAcceptance } from './identity/supervisor-identity-acceptance.js';
import { acquireAndReconcileSupervisorOriginalSDK } from './identity/supervisor-sdk-reconciliation.js';
import {
  createSupervisorNativeIdentity,
  consumeSupervisorNativeIdentity,
  nativeRuntimeForSupervisorIdentity,
} from './identity/supervisor-native-identity.js';
import { ownSupervisorProxyAuthentication } from './identity/supervisor-proxy-authentication.js';
import { readSupervisorOriginalCatalog } from './identity/supervisor-original-catalog.js';
import { createSupervisorChromeBarrier } from './identity/supervisor-chrome-barrier.js';
import { parseRuntimeDescriptor } from '../runtime-descriptor.js';
import {
  createSupervisorProtocolWire,
  releaseOriginalWireRetirement,
} from './identity/supervisor-protocol-wire.js';
import { DefaultDownloadOwner, closeBrowserAndDownloads } from './default-downloads.js';
import {
  ownPrivateProxyAuthentication,
  joinOriginalProxyAuthenticationStop,
} from './private-proxy-auth.js';
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
import { completeInventory } from '../lifecycle/inventory.js';
import { ownDirectory, assertDirectory, type OwnedDirectory } from '../profiles/owned-directory.js';

type State = {
  directory: OwnedDirectory;
  child?: DarwinOwnedChild;
  browser?: Browser;
  originalBrowserClose?: () => Promise<unknown>;
  sdkWire?: ReturnType<typeof createSupervisorProtocolWire>;
  sdkReady?: Promise<void>;
  authWire?: ReturnType<typeof createSupervisorProtocolWire>;
  authWireReady?: Promise<void>;
  chromeBarrier?: ReturnType<typeof createSupervisorChromeBarrier>;
  chromeAuth?: ReturnType<typeof ownSupervisorProxyAuthentication>;
  identityOwner?: ReturnType<typeof createSupervisorNativeIdentity>;
  identityReady?: Promise<object>;
  reconciliationOriginals: Set<Promise<unknown>>;
  reconciliationCloses: Set<() => Promise<void>>;
  proxy?: FixtureProxy;
  auth?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>>;
  uncertain: boolean;
  cleanup?: Promise<unknown>;
  downloads?: DefaultDownloadOwner;
  originalChild?: Promise<void>;
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
    /** Constructor-private original native installation descriptor; no UA or qualification DTO. */
    identityPreparation?: Readonly<{ nativeRuntime: BrowserRuntimeDescriptor }>;
    /** Private controlled-peer lease: not accepted by the public or supervisor RPC schemas. */
    originalIdentityAcceptance?: object;
    ownedProxy?: Readonly<{
      url: string;
      credentials: Readonly<{ username: string; password: string }>;
    }>;
  }>,
  failed: (cause: 'custody' | 'browser', root?: ProcessIdentity) => void = () => {},
  originalRootReturned?: (root: ProcessIdentity) => void | Promise<void>,
  originalChild?: (
    original: Readonly<{
      root: ProcessIdentity;
      supervisor: ProcessIdentity;
      manager: ProcessIdentity;
      identities: readonly ProcessIdentity[];
      complete: boolean;
    }>
  ) => Promise<void>,
  originalBaselineObserved?: (identities: readonly ProcessIdentity[]) => void | Promise<void>,
  isAdmissionCurrent: () => boolean = () => true
) {
  if (endpointUncertain) throw new Error('DEVTOOLS_CLOSE_UNCERTAIN');
  const admitOriginal = isAdmissionCurrent;
  const runtime = parseRuntimeDescriptor(options.runtime);
  const acceptance = options.originalIdentityAcceptance
    ? consumeSupervisorIdentityAcceptance(options.originalIdentityAcceptance)
    : undefined;
  if (acceptance && (!options.identityPreparation || options.ownedProxy))
    throw new Error('IDENTITY_ACCEPTANCE_CONFIGURATION_REFUSED');
  const ownedProxy = acceptance?.proxy ?? options.ownedProxy;
  if (
    (runtime.identity.mode === 'chrome-compatible') !== !!options.identityPreparation ||
    (options.identityPreparation && !ownedProxy)
  )
    throw new Error('IDENTITY_MODE_UNAVAILABLE');
  const directory = ownDirectory(options.profileDir);
  for (const original of retained)
    if (
      original.directory.path === directory.path ||
      (original.directory.dev === directory.dev && original.directory.ino === directory.ino)
    )
      throw new Error('SUPERVISOR_PROFILE_UNCERTAIN');
  // Registration is synchronous, before any metadata/library acquisition or await.
  const state: State = {
    directory,
    uncertain: false,
    reconciliationOriginals: new Set(),
    reconciliationCloses: new Set(),
  };
  retained.add(state);
  const closeDiagnostic = createSupervisorUncertaintyDiagnostic();
  const uncertain = (code: SupervisorUncertaintyCode) => {
    state.uncertain = true;
    closeDiagnostic.note(code);
  };
  acceptance?.captureShutdown(async () => {
    await state.cleanup;
  });
  const artifact = Object.freeze({ ...options.artifact });
  const processes = createDarwinEngineProcesses(artifact);
  const admit = () => {
    acceptance?.current();
    if (admitOriginal() !== true || state.uncertain) throw new Error('SUPERVISOR_ADMISSION_CLOSED');
    assertDirectory(directory);
  };
  const file = join(options.profileDir, 'DevToolsActivePort');
  let before: string | null = null;
  let root: ProcessIdentity;
  let supervisor: ProcessIdentity;
  let endpointURL: string;
  try {
    let selectedIdentity: ReturnType<typeof consumeSupervisorNativeIdentity> | undefined;
    let chromium: Awaited<ReturnType<typeof verifiedLibrary>>;
    if (options.identityPreparation) {
      state.identityOwner = createSupervisorNativeIdentity({
        nativeRuntime: options.identityPreparation.nativeRuntime,
        candidateRuntime: runtime,
        artifact,
        isAdmissionCurrent: admitOriginal,
      });
      state.identityReady = state.identityOwner.prepare();
      const plan = await state.identityReady;
      if (originalBaselineObserved)
        await originalBaselineObserved(state.identityOwner.knownNativeOriginals());
      chromium = await verifiedLibrary(nativeRuntimeForSupervisorIdentity(plan));
      selectedIdentity = consumeSupervisorNativeIdentity(plan, runtime, chromium);
      acceptance?.captureConsumedBaseline(selectedIdentity.nativeIdentity);
      await state.identityOwner.close();
    } else chromium = await verifiedLibrary(runtime);
    admit();
    try {
      const stat = await lstat(file, { bigint: true });
      if (!stat.isFile() || stat.size > 1024n || stat.uid !== BigInt(process.getuid!()))
        throw new Error('DEVTOOLS_ENDPOINT_UNAVAILABLE');
      before = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!ownedProxy) state.proxy = await startFixtureProxy(options.origin);
    admit();
    state.child = await createDarwinOwnedChildLauncher({
      artifact,
      manager: options.manager,
    }).launch({
      executable: runtime.executable.path,
      cwd: options.profileDir,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: options.profileDir,
        LANG: 'C',
        LC_ALL: 'C',
      },
      argv: [
        '--headless=new',
        ...(selectedIdentity ? [`--user-agent=${selectedIdentity.userAgent}`] : []),
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
        ...(acceptance?.argv ?? []),
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${options.profileDir}`,
        `--proxy-server=${ownedProxy?.url ?? state.proxy!.url}`,
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        'about:blank',
      ],
    });
    await acceptance?.captureChild(state.child);
    root = await state.child.identity();
    admit();
    const originalRoot = root;
    state.child.child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        uncertain('NATIVE_CHILD_EXIT');
        failed('browser', originalRoot);
      }
    });
    if (originalChild) {
      const sender = await processes.identity(process.pid);
      if (!sender) throw new Error('SUPERVISOR_IDENTITY_UNAVAILABLE');
      supervisor = sender;
      let cohort: readonly ProcessIdentity[] = Object.freeze([Object.freeze({ ...root })]);
      let observationFailure: { value: unknown } | undefined;
      const abort = new AbortController();
      try {
        cohort = completeInventory(await processes.processes.descendants(root, abort.signal), root);
      } catch (value) {
        observationFailure = { value };
      } finally {
        abort.abort();
      }
      const original = Object.freeze({
        identities: cohort,
        complete: observationFailure === undefined,
        root: Object.freeze({ ...root }),
        supervisor: Object.freeze({ ...sender }),
        manager: Object.freeze({ ...options.manager }),
      });
      // Publish the original operation before a receiver can reenter or reject, including falsy.
      state.originalChild = Promise.resolve().then(() => originalChild(original));
      await state.originalChild;
      if (observationFailure) throw observationFailure.value;
    }
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
    admit();
    if (!holder || !sameProcess(holder, root)) throw new Error('DEVTOOLS_ROOT_MISMATCH');
    const sender = await processes.identity(process.pid);
    admit();
    if (!sender) throw new Error('SUPERVISOR_IDENTITY_UNAVAILABLE');
    supervisor = sender;
    // The attributed original root owns this channel before any auth/SDK initialization.
    state.sdkWire = createSupervisorProtocolWire(url);
    let originalSDKTransport = state.sdkWire.transport;
    let initialCatalog: Awaited<ReturnType<typeof readSupervisorOriginalCatalog>> | undefined;
    if (selectedIdentity) {
      state.authWire = createSupervisorProtocolWire(url);
      state.sdkReady = state.sdkWire.open();
      state.authWireReady = state.authWire.open();
      await waitWithin(
        Promise.all([state.sdkReady, state.authWireReady]),
        Math.max(1, end - performance.now())
      );
      admit();
      const initial = await readSupervisorOriginalCatalog(state.sdkWire.transport);
      admit();
      initialCatalog = initial;
      state.chromeBarrier = createSupervisorChromeBarrier({
        sdk: state.sdkWire.transport,
        authentication: state.authWire.transport,
        root: initial,
        payload: selectedIdentity.payload,
        authenticationRequired: true,
        ...(acceptance?.withholdFirstIdentityAcknowledgement
          ? { withholdFirstIdentityAcknowledgement: true as const }
          : {}),
        assertOriginalPeerCloseOwner() {
          assertDirectory(directory);
          if (state.uncertain || !state.child?.custody().pending)
            throw new Error('SUPERVISOR_IDENTITY_OWNER_UNAVAILABLE');
        },
        assertOriginalOwner() {
          admit();
          if (state.uncertain || !state.child?.custody().pending)
            throw new Error('SUPERVISOR_IDENTITY_OWNER_UNAVAILABLE');
        },
      });
      // Attach the real original credential listener before the first autoattach producer.
      // No third authentication socket; both consumers use the two owned barrier channels.
      state.chromeAuth = ownSupervisorProxyAuthentication(
        state.chromeBarrier.authentication,
        ownedProxy!,
        () => {
          uncertain('NATIVE_CHROME_AUTH_LOSS');
          failed('custody');
        }
      );
      await state.chromeBarrier.startAuthentication();
      admit();
      originalSDKTransport = state.chromeBarrier.sdk;
    } else {
      if (ownedProxy)
        state.auth = await ownPrivateProxyAuthentication(url, ownedProxy, () => {
          uncertain('NATIVE_PROXY_AUTH_LOSS');
          failed('custody');
        });
      state.sdkReady = state.sdkWire.open();
      await waitWithin(state.sdkReady, Math.max(1, end - performance.now()));
    }
    admit();
    state.browser = await chromium.connectOverCDP(originalSDKTransport, {
      timeout: Math.max(1, end - performance.now()),
      noDefaults: true,
    });
    admit();
    state.downloads = new DefaultDownloadOwner(
      state.browser,
      () => !state.uncertain && performance.now() < end,
      () => {
        uncertain('NATIVE_DOWNLOAD_LOSS');
        failed('custody');
      }
    );
    await waitWithin(state.downloads.ready, Math.max(1, end - performance.now()));
    if (state.browser.contexts().length !== 1) throw new Error('PERSISTENT_CONTEXT_UNAVAILABLE');
    if (selectedIdentity) {
      // Reserve cleanup before the original asynchronous session acquisition can enter.
      // A late returned session is captured before admission is checked again.
      const acquireBrowserSession = state.browser.newBrowserCDPSession.bind(state.browser);
      let closeSession: Awaited<ReturnType<typeof acquireBrowserSession>> | undefined;
      let detachSession: (() => Promise<void>) | undefined;
      let sendCloseOriginal: import('playwright-core').CDPSession['send'] | undefined;
      let closeEntered = false;
      let settleAcquisition!: () => void;
      const acquired = new Promise<void>((resolve) => {
        settleAcquisition = resolve;
      });
      let sessionCleanup: Promise<void> | undefined;
      const cleanup = () =>
        (sessionCleanup ??= Promise.resolve().then(async () => {
          await acquired;
          // Successful Browser.close is joined with the whole original SDK/child close below.
          // Before that effect, this exact returned session has its independent detach duty.
          if (closeSession && !closeEntered) {
            if (!detachSession) throw new Error('SUPERVISOR_ORIGINAL_BROWSER_DETACH_UNCAPTURED');
            await detachSession();
          }
        }));
      state.reconciliationCloses.add(cleanup);
      const acquisition = Promise.resolve().then(async () => {
        try {
          admit();
          await state.chromeBarrier!.acquireOriginalBrowserCloseSession(async () => {
            closeSession = await acquireBrowserSession();
            const detach = closeSession.detach;
            if (typeof detach !== 'function')
              throw new Error('SUPERVISOR_ORIGINAL_BROWSER_DETACH_UNCAPTURED');
            detachSession = detach.bind(closeSession);
            const send = closeSession.send;
            if (typeof send !== 'function')
              throw new Error('SUPERVISOR_ORIGINAL_BROWSER_SEND_UNCAPTURED');
            sendCloseOriginal = send.bind(closeSession);
            return closeSession;
          });
          if (!closeSession) throw new Error('SUPERVISOR_ORIGINAL_BROWSER_SESSION_MISSING');
          if (!sendCloseOriginal) throw new Error('SUPERVISOR_ORIGINAL_BROWSER_SEND_UNCAPTURED');
          state.originalBrowserClose = () => {
            closeEntered = true;
            return sendCloseOriginal!('Browser.close');
          };
        } finally {
          settleAcquisition();
        }
      });
      state.reconciliationOriginals.add(acquisition);
      try {
        await acquisition;
      } finally {
        state.reconciliationOriginals.delete(acquisition);
      }
      admit();
      const originalContext = state.browser.contexts()[0]!;
      const pages = originalContext.pages();
      if (pages.length !== 1) throw new Error('SUPERVISOR_IDENTITY_CONTEXT_CHANGED');
      const createSession = originalContext.newCDPSession.bind(originalContext);
      const guard = () => {
        admit();
        if (state.uncertain || !state.child?.custody().pending)
          throw new Error('SUPERVISOR_IDENTITY_OWNER_UNAVAILABLE');
      };
      // Read the already observed catalog again only from the initial target facts, never a body.
      // The bridge's original root is retained separately before SDK initialization.
      const catalog = initialCatalog!;
      await acquireAndReconcileSupervisorOriginalSDK(
        () => createSession(pages[0]!),
        catalog,
        (_label, producer) => {
          const original = Promise.resolve().then(producer);
          state.reconciliationOriginals.add(original);
          void original.then(
            () => state.reconciliationOriginals.delete(original),
            () => state.reconciliationOriginals.delete(original)
          );
          return original;
        },
        guard,
        () => {
          uncertain('NATIVE_RECONCILIATION_LOSS');
          failed('custody');
        },
        (close) => {
          state.reconciliationCloses.add(close);
        }
      );
    }
  } catch (error) {
    uncertain('NATIVE_STARTUP_FAILURE');
    acceptance?.captureWithheld(
      state.chromeBarrier?.status().identityAcknowledgementWithheld === true
    );
    if (state.identityOwner && originalBaselineObserved) {
      try {
        await originalBaselineObserved(state.identityOwner.knownNativeOriginals());
      } catch {
        /* The original body remains primary; acquisition cannot become healthy. */
      }
    }
    state.downloads?.retire();
    // Failure remains retained; request cooperative stop of the actual original only.
    try {
      state.child?.child.kill('SIGTERM');
    } catch {
      /* Original custody remains retained. */
    }
    const failedSessionCleanup = Promise.allSettled(
      [...state.reconciliationCloses].map((close) => Promise.resolve().then(close))
    );
    state.cleanup = Promise.allSettled([
      failedSessionCleanup,
      // Join initialization even if the independent original browser closure refuses.
      state.downloads?.ready,
      state.originalChild,
      state.sdkReady,
      state.authWireReady,
      state.identityReady,
      ...state.reconciliationOriginals,
      ...[...state.reconciliationCloses].map((close) => Promise.resolve().then(close)),
      Promise.resolve().then(async () => {
        await failedSessionCleanup;
        await closeBrowserAndDownloads(state.browser, state.downloads);
      }),
      Promise.resolve().then(() => state.proxy?.close()),
      Promise.resolve().then(() => state.auth?.close()),
      Promise.resolve().then(() => state.sdkWire?.close()),
      Promise.resolve().then(() => state.authWire?.close()),
      Promise.resolve().then(() => state.chromeAuth?.close()),
      Promise.resolve().then(() => state.chromeBarrier?.close()),
      Promise.resolve().then(() => state.identityOwner?.close()),
      Promise.resolve().then(() => state.child?.completion()),
    ]);
    await waitWithin(state.cleanup, 2000).catch(() => {});
    throw error;
  }
  acceptance?.captureWithheld(
    state.chromeBarrier?.status().identityAcknowledgementWithheld === true
  );
  const browser = state.browser,
    child = state.child,
    proxy = state.proxy;
  const context: BrowserContext = browser.contexts()[0]!;
  const killOriginalChild = child.child.kill.bind(child.child);
  let closing: Promise<boolean> | undefined;
  return Object.freeze({
    context,
    root,
    child,
    supervisor,
    proxyURL: ownedProxy?.url ?? proxy!.url,
    endpointURL,
    close() {
      if (closing) return closing;
      state.downloads?.retire();
      const pendingClose = createOriginalClosePendingDiagnostic();
      const original = (async () => {
        const abort = new AbortController();
        let tree: ProcessTreeObservation = {
          status: 'unknown',
          identities: [],
        };
        try {
          tree = await pendingClose.observe(
            'NATIVE_CLOSE_PENDING_TREE',
            processes.processes.descendants(root, abort.signal)
          );
        } catch {
          uncertain('NATIVE_TREE_QUERY');
        }
        if (tree.status !== 'complete') uncertain('NATIVE_TREE_INCOMPLETE');
        let childStopEntered = false;
        const stopOriginalChild = () => {
          if (childStopEntered) return;
          childStopEntered = true;
          killOriginalChild('SIGTERM');
        };
        const originalAuthenticationClose = pendingClose.observe(
          'NATIVE_CLOSE_PENDING_AUTH_TERMINAL',
          Promise.resolve().then(() => state.auth?.close())
        );
        const originalAuthenticationEntry = pendingClose.observe(
          'NATIVE_CLOSE_PENDING_AUTH_ENTRY',
          Promise.resolve().then(() => state.auth?.prepareClose())
        );
        const originalBrowserStop = joinOriginalProxyAuthenticationStop(
          originalAuthenticationEntry,
          async () => {
            const closeOriginal =
              state.originalBrowserClose ??
              (async () => {
                const session = await browser.newBrowserCDPSession();
                return session.send('Browser.close');
              });
            // A failed mark cannot skip the independent original Browser.close producer.
            let markingFailure: Readonly<{ value: unknown }> | undefined;
            for (const mark of [
              () => state.sdkWire!.enterOriginalPeerClose(),
              () => state.authWire?.enterOriginalPeerClose(),
              () => state.chromeAuth?.enterOriginalPeerClose(),
              () => state.chromeBarrier?.enterOriginalPeerClose(),
            ])
              try {
                mark();
              } catch (value) {
                markingFailure ??= { value };
              }
            let primary = markingFailure;
            if (markingFailure) {
              // A failed directory/currentness mark cannot suppress the independently owned
              // original child stop. This signals only the retained child capability.
              try {
                stopOriginalChild();
              } catch (value) {
                primary ??= { value };
              }
            }
            try {
              await pendingClose.observe('NATIVE_CLOSE_PENDING_BROWSER', closeOriginal());
            } catch (value) {
              primary ??= { value };
              try {
                stopOriginalChild();
              } catch (value) {
                primary ??= { value };
              }
            }
            if (primary) throw primary.value;
          }
        );
        const results = await Promise.allSettled([
          originalBrowserStop,
          pendingClose.observe(
            'NATIVE_CLOSE_PENDING_PROXY',
            Promise.resolve().then(() => proxy?.close())
          ),
          originalAuthenticationClose,
          // Closing the bridge closes SDK too: it must not race an unentered Browser.close.
          Promise.resolve().then(async () => {
            await Promise.allSettled([originalBrowserStop]);
            await pendingClose.observe(
              'NATIVE_CLOSE_PENDING_CHROME_AUTH',
              Promise.resolve(state.chromeAuth?.close())
            );
          }),
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
        if (results.some((result) => result.status === 'rejected')) uncertain('NATIVE_STOP_JOIN');
        const originalBrowserStopResult = results[0]!;
        const returned = await pendingClose.observe('NATIVE_CLOSE_PENDING_CHILD', child.returned());
        // The actual original child capability is checked before the private event producer.
        // Reserve its promise before entering the captured receiver; join independently below.
        let originalReturnedAccepted = false;
        const rootReturnForward =
          returned &&
          (originalReturnedAccepted = acceptsDarwinOwnedChildReturn(child, returned)) &&
          originalRootReturned
            ? Promise.resolve().then(() => originalRootReturned(Object.freeze({ ...root })))
            : Promise.resolve();
        void rootReturnForward.catch(() => {});
        if (!returned)
          process.stderr.write(
            'SUPERVISOR_CHILD_RETURN: ' + String(child.custody().firstCause) + '\n'
          );
        let statuses: { status: 'alive' | 'dead' | 'unknown' }[] = [];
        const nativeEnd = performance.now() + 2000;
        const goneSettled = pendingClose.enter('NATIVE_CLOSE_PENDING_GONE');
        try {
          do {
            statuses = await Promise.all(
              tree.identities.map((identity) => processes.observeTerminated(identity, abort.signal))
            );
            if (statuses.length && statuses.every((value) => value.status === 'dead')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } while (performance.now() < nativeEnd);
        } catch {
          uncertain('NATIVE_GONE_QUERY');
        } finally {
          goneSettled();
        }
        try {
          await pendingClose.observe(
            'NATIVE_CLOSE_PENDING_DOWNLOADS',
            closeBrowserAndDownloads(browser, state.downloads)
          );
        } catch {
          uncertain('NATIVE_DOWNLOAD_CLOSE');
        }
        let qualifiedSDKRetirement: Readonly<{ reason: unknown }> | undefined;
        try {
          const results = await pendingClose.observe(
            'NATIVE_CLOSE_PENDING_WIRES',
            Promise.allSettled([
              state.sdkWire!.close(),
              state.authWire?.close(),
              state.chromeBarrier?.close(),
              state.identityOwner?.close(),
              ...state.reconciliationOriginals,
              ...[...state.reconciliationCloses].map((close) => Promise.resolve().then(close)),
            ])
          );
          const qualifiedRetirement = classifyOriginalWireRetirement({
            wire: state.sdkWire!,
            result: results[0]!,
            originalBrowserStop: originalBrowserStopResult,
            originalReturnedAccepted,
            otherOriginalsKnown:
              !state.uncertain &&
              results.every((result, index) => index === 0 || result.status === 'fulfilled'),
            root,
            tree,
            statuses,
          });
          if (qualifiedRetirement && results[0]?.status === 'rejected')
            qualifiedSDKRetirement = Object.freeze({ reason: results[0].reason });
          const rejected = results.findIndex(
            (result, index) => result.status === 'rejected' && !(index === 0 && qualifiedRetirement)
          );
          if (rejected >= 0) {
            state.uncertain = true;
            closeDiagnostic.note(
              rejected === 0
                ? 'NATIVE_SDK_WIRE_CLOSE'
                : rejected === 1
                  ? 'NATIVE_AUTH_WIRE_CLOSE'
                  : rejected === 2
                    ? 'NATIVE_CHROME_BARRIER_CLOSE'
                    : rejected === 3
                      ? 'NATIVE_IDENTITY_CLOSE'
                      : 'NATIVE_RECONCILIATION_CLOSE'
            );
          }
        } catch {
          uncertain('NATIVE_WIRE_JOIN_THROW');
        }
        try {
          await pendingClose.observe('NATIVE_CLOSE_PENDING_ROOT_FORWARD', rootReturnForward);
        } catch {
          uncertain('NATIVE_ROOT_FORWARD');
        }
        abort.abort();
        if (
          !returned ||
          !acceptsDarwinOwnedChildReturn(child, returned) ||
          !statuses.length ||
          statuses.some((value) => value.status !== 'dead')
        )
          uncertain('NATIVE_FINAL_CUSTODY');
        if (
          !state.uncertain &&
          qualifiedSDKRetirement &&
          !releaseOriginalWireRetirement(state.sdkWire!, qualifiedSDKRetirement.reason)
        )
          uncertain('NATIVE_SDK_WIRE_CLOSE');
        if (!state.uncertain) retained.delete(state);
        if (state.uncertain) closeDiagnostic.emit();
        return !state.uncertain;
      })();
      state.cleanup = original; // The deadline never relinquishes the actual originals or operation.
      closing = waitWithin(original, 5000).catch(() => {
        uncertain('NATIVE_CLOSE_WAIT');
        pendingClose.emit();
        closeDiagnostic.emit();
        return false;
      });
      return closing;
    },
  });
}
