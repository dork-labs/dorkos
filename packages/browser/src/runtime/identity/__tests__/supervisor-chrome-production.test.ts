import { expect, it, vi, onTestFinished } from 'vitest';
import { mkdtemp, writeFile, rm, access, rename, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { launchDarwinSupervisorBrowser } from '../../darwin-supervisor-browser.js';
import type { BrowserRuntimeDescriptor } from '../../../runtime-descriptor.js';
const mocks = vi.hoisted(() => ({
  library: vi.fn(),
  launcher: vi.fn(),
  processes: vi.fn(),
  cohort: vi.fn(),
}));
vi.mock('../../public-library.js', () => ({ verifiedLibrary: mocks.library }));
vi.mock('../../darwin-owned-child.js', () => ({
  createDarwinOwnedChildLauncher: () => ({ launch: mocks.launcher }),
  acceptsDarwinOwnedChildReturn: () => true,
}));
vi.mock('../../darwin-engine-processes.js', () => ({
  createDarwinEngineProcesses: mocks.processes,
}));
vi.mock('../supervisor-native-cohort.js', () => ({
  createSupervisorNativeCohort: mocks.cohort,
}));
vi.mock('../../default-downloads.js', () => ({
  DefaultDownloadOwner: class {
    ready = Promise.resolve();
    retire() {}
    close() {
      return Promise.resolve();
    }
  },
  closeBrowserAndDownloads: async (
    browser?: { close(): Promise<void> },
    downloads?: { close(): Promise<void> }
  ) => {
    await Promise.all([browser?.close(), downloads?.close()]);
  },
}));
const native: BrowserRuntimeDescriptor = {
  library: {
    package: 'playwright-core',
    version: '1.63.0',
    rootDir: '/original/library',
    assets: { manifest: 'browsers.json', cli: 'cli.js' },
  },
  executable: {
    path: '/original/chromium',
    sha256: 'a'.repeat(64),
    revision: '1234',
    version: '153.0.8010.12',
    platform: 'darwin',
    arch: 'arm64',
  },
  identity: { mode: 'native', policyRevision: 7 },
};
const candidate = {
  ...native,
  identity: { ...native.identity, mode: 'chrome-compatible' as const },
};
const nativeIdentity = {
  userAgent: 'Mozilla/5.0 HeadlessChrome/153.0.0.0',
  appVersion: '5.0 HeadlessChrome/153.0.0.0',
  platform: 'MacIntel',
  secureContext: true,
  metadata: {
    brands: [{ brand: 'Chromium', version: '153' }],
    mobile: false,
    platform: 'macOS',
    fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }],
    uaFullVersion: '153.0.8010.12',
    architecture: 'arm',
    bitness: '64',
    model: '',
    platformVersion: '15.0.0',
    wow64: false,
    formFactors: ['Desktop'],
  },
};
/** Actual production selector/baseline/receiver/wire/bridge/auth consumers. SDK, child and
 * process observations are semantic doubles; no real process or native-matrix pass claimed. */
function fixture(
  options: {
    holdBrowserSession?: true;
    substituteCloseSession?: true;
    replaceDetachAfterFirst?: true;
  } = {}
) {
  const work = new Set<Promise<unknown>>(),
    releases: (() => void)[] = [],
    accepted = new Set<unknown>();
  const profiles = new Set<string>();
  let admissionCurrent = true;
  let expectedHeld = false;
  let sessionEntered!: () => void;
  const sessionStarted = new Promise<void>((resolve) => {
    sessionEntered = resolve;
  });
  let returnAttachReply: (() => void) | undefined;
  let releaseBrowserReply!: () => void;
  const browserAttached = new Promise<void>((resolve) => {
    releaseBrowserReply = resolve;
  });
  const releaseSession = () => {
    const original = returnAttachReply;
    returnAttachReply = undefined;
    original?.();
  };
  releases.push(releaseSession);
  const extraHomes = new Set<string>();
  const detachBrowserSession = vi.fn(async () => {});
  const replacementDetach = vi.fn(async () => {
    throw new Error('REPLACEMENT_DETACH_ENTERED');
  });
  let detachReads = 0;
  let sdkTransport: import('playwright-core').ConnectOverCDPTransport | undefined;
  let selected: Awaited<ReturnType<typeof launchDarwinSupervisorBrowser>> | undefined;
  let home: string | undefined;
  onTestFinished(async () => {
    for (const release of releases) release();
    const results = await Promise.allSettled([...work]);
    let primary: Readonly<{ value: unknown }> | undefined;
    for (const result of results)
      if (result.status === 'rejected' && !accepted.has(result.reason))
        primary ??= { value: result.reason };
    if (selected)
      try {
        const returned = await selected.close();
        if (returned !== !expectedHeld) throw new Error('SEMANTIC_ORIGINAL_CLOSE_UNVERIFIED');
      } catch (value) {
        primary ??= { value };
      }
    const removals = await Promise.allSettled([
      ...[...extraHomes].map((path) => rm(path, { recursive: true, force: true })),
      ...[...profiles].map((path) => rm(path, { recursive: true, force: true })),
      ...(home ? [rm(home, { recursive: true, force: true })] : []),
    ]);
    for (const result of removals)
      if (result.status === 'rejected') primary ??= { value: result.reason };
    vi.unstubAllGlobals();
    for (const mock of Object.values(mocks)) mock.mockReset();
    if (primary) throw primary.value;
  });
  const own = <T>(original: Promise<T>) => {
    work.add(original);
    void original.catch(() => {});
    return original;
  };
  const sockets: OriginalSocket[] = [];
  type Message = Record<string, unknown>;
  class OriginalSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    messages: Message[] = [];
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    emit(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    send(bytes: string) {
      const message = JSON.parse(bytes) as Message;
      this.messages.push(message);
      let result: unknown = {};
      if (message.method === 'Target.attachToBrowserTarget')
        result = { sessionId: 'original-browser-session' };
      if (message.method === 'Target.getBrowserContexts') result = { browserContextIds: [] };
      if (message.method === 'Target.getTargets')
        result = {
          targetInfos: [
            {
              targetId: 'original-root-page',
              type: 'page',
              url: 'about:blank',
              browserContextId: 'original-context',
            },
          ],
        };
      if (message.method === 'Target.setAutoAttach' && message.sessionId === undefined)
        this.emit({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: sockets.indexOf(this) === 0 ? 'sdk-root' : 'auth-root',
            waitingForDebugger: false,
            targetInfo: {
              targetId: 'original-root-page',
              type: 'page',
              url: 'about:blank',
              browserContextId: 'original-context',
            },
          },
        });
      const reply = () => this.emit({ id: message.id, sessionId: message.sessionId, result });
      if (message.method === 'Target.attachToBrowserTarget' && options.holdBrowserSession) {
        returnAttachReply = reply;
        return;
      }
      reply();
      if (message.method === 'Browser.close') {
        for (const socket of sockets) socket.close();
        childPending = false;
        childEmitter.emit('exit', 0, null);
      }
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', OriginalSocket);
  const baselineClose = vi.fn(async () => {});
  let originalURL = '';
  const baselineContext = {
    close: baselineClose,
    browser: () => ({ version: () => native.executable.version }),
    pages: () => [
      {
        context: () => baselineContext,
        url: () => originalURL,
        goto: async (url: string) => {
          originalURL = url;
          const response = await fetch(url, {
            headers: { 'User-Agent': nativeIdentity.userAgent },
          });
          await response.arrayBuffer();
        },
        evaluate: async () => structuredClone(nativeIdentity),
      },
    ],
  };
  const root = { pid: 500001, birth: 'semantic-original-root' },
    supervisor = { pid: process.pid, birth: 'semantic-supervisor' };
  const childEmitter = new EventEmitter();
  let childPending = true;
  const browser = {
    contexts: () => [
      {
        pages: () => [{}],
        newCDPSession: async () => ({
          send: async () => ({
            targetInfo: {
              targetId: 'original-root-page',
              browserContextId: 'original-context',
              url: 'about:blank',
            },
          }),
          detach: async () => {},
        }),
      },
    ],
    close: vi.fn(async () => {}),
    newBrowserCDPSession: vi.fn(async () => {
      if (!sdkTransport) throw new Error('ORIGINAL_SDK_TRANSPORT_UNCAPTURED');
      sdkTransport.send({ id: 101, method: 'Target.attachToBrowserTarget', params: {} });
      sessionEntered();
      await browserAttached;
      return {
        get detach() {
          detachReads++;
          return options.replaceDetachAfterFirst && detachReads > 1
            ? replacementDetach
            : detachBrowserSession;
        },
        send: async (method: string) => {
          if (method !== 'Browser.close') throw new Error('UNEXPECTED_ORIGINAL_COMMAND');
          if (!sdkTransport) throw new Error('ORIGINAL_SDK_TRANSPORT_UNCAPTURED');
          sdkTransport.send({
            id: 100,
            sessionId: options.substituteCloseSession
              ? 'foreign-browser-session'
              : 'original-browser-session',
            method: 'Browser.close',
            params: {},
          });
          return {};
        },
      };
    }),
  };
  const sdk = {
    launchPersistentContext: vi.fn(async (profile: string) => {
      profiles.add(profile);
      return baselineContext;
    }),
    connectOverCDP: vi.fn(async (transport: import('playwright-core').ConnectOverCDPTransport) => {
      sdkTransport = transport;
      await new Promise<void>((resolve) => {
        transport.onmessage = (value) => {
          const message = value as Message;
          if (message.method === 'Target.attachedToTarget')
            transport.send({
              id: 99,
              sessionId: 'sdk-root',
              method: 'Runtime.runIfWaitingForDebugger',
              params: {},
            });
          if (message.id === 101) releaseBrowserReply();
          if (message.id === 99) resolve();
        };
        transport.onclose = () => {};
        transport.send({
          id: 98,
          method: 'Target.setAutoAttach',
          params: {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          },
        });
      });
      return browser;
    }),
  };
  mocks.library.mockResolvedValue(sdk);
  mocks.cohort.mockReturnValue({
    beforeLaunch: async () => {},
    afterLaunch: async () => {},
    beforeOriginalClose: async () => {},
    afterOriginalClose: async () => {},
    observedBirths: () => [root],
  });
  mocks.processes.mockReturnValue({
    holder: async () => root,
    identity: async () => supervisor,
    processes: {
      descendants: async () => ({ status: 'complete', identities: [root] }),
    },
    observeTerminated: async () => ({ status: 'dead' }),
  });
  mocks.launcher.mockImplementation(async (options: { cwd: string; argv: string[] }) => {
    expect(baselineClose).toHaveBeenCalledTimes(1);
    for (const profile of profiles)
      await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(
      join(options.cwd, 'DevToolsActivePort'),
      '4444\n/devtools/browser/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n'
    );
    return {
      identity: async () => root,
      child: Object.assign(childEmitter, {
        kill: vi.fn(() => {
          childPending = false;
          for (const socket of sockets) socket.close();
          childEmitter.emit('exit', null, 'SIGTERM');
          return true;
        }),
      }),
      custody: () => ({ pending: childPending }),
      completion: async () => {},
      returned: async () => ({}),
    };
  });
  const open = () =>
    own(
      (async () => {
        home = await realpath(await mkdtemp(join(tmpdir(), 'chrome-production-semantic-')));
        const result = await launchDarwinSupervisorBrowser(
          {
            manager: { pid: 500000, birth: 'semantic-manager' },
            runtime: candidate,
            artifact: {
              path: '/original/native-observer',
              sha256: 'b'.repeat(64),
            },
            profileDir: home,
            origin: 'about:blank',
            identityPreparation: { nativeRuntime: native },
            ownedProxy: {
              url: 'http://127.0.0.1:49111',
              credentials: {
                username: 'dorkos',
                password: 'private-semantic-peer',
              },
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          () => admissionCurrent
        );
        selected = result;
        return result;
      })()
    );
  return {
    open,
    own,
    sdk,
    sockets,
    baselineClose,
    accepted,
    revokeAdmission() {
      admissionCurrent = false;
    },
    browser,
    detachBrowserSession,
    replacementDetach,
    detachReads: () => detachReads,
    sessionStarted,
    releaseSession,
    async replaceDirectory() {
      if (!home) throw new Error('ORIGINAL_PROFILE_MISSING');
      const moved = home + '-original';
      await rename(home, moved);
      extraHomes.add(moved);
      await mkdir(home, { mode: 0o700 });
    },
    expectHeldClose() {
      expectedHeld = true;
    },
  };
}

it('consumes the original closed native baseline in the same Darwin launch and only two original channels', async () => {
  const f = fixture(),
    original = await f.open();
  expect(f.sockets).toHaveLength(2);
  const launch = mocks.launcher.mock.calls[0]![0] as { argv: string[] };
  expect(launch.argv).toContain('--user-agent=Mozilla/5.0 Chrome/153.0.0.0');
  expect(f.sdk.launchPersistentContext).toHaveBeenCalledTimes(1);
  expect(f.sdk.connectOverCDP).toHaveBeenCalledTimes(1);
  const auth = f.sockets[1]!;
  auth.emit({
    method: 'Fetch.authRequired',
    sessionId: 'auth-root',
    params: {
      requestId: 'original-challenge',
      authChallenge: { source: 'Proxy', origin: 'http://127.0.0.1:49111' },
    },
  });
  const replies = auth.messages.filter((message) => message.method === 'Fetch.continueWithAuth');
  expect(replies).toHaveLength(1);
  expect(replies[0]!.params).toEqual({
    requestId: 'original-challenge',
    authChallengeResponse: {
      response: 'ProvideCredentials',
      username: 'dorkos',
      password: 'private-semantic-peer',
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(await f.own(original.close())).toBe(true);
});

it('closes the exact consumed Chrome owner after worker admission is revoked', async () => {
  const f = fixture(),
    original = await f.open();
  f.revokeAdmission();
  const closing = f.own(original.close());
  expect(original.close()).toBe(closing);
  expect(await closing).toBe(true);
  expect(f.browser.close).toHaveBeenCalledTimes(1);
  expect(
    f.sockets[0]!.messages.filter((message) => message.method === 'Browser.close')
  ).toHaveLength(1);
  expect(f.sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it('refuses a successful close after original directory replacement and still stops the owned child', async () => {
  const f = fixture(),
    original = await f.open();
  await f.replaceDirectory();
  f.expectHeldClose();
  f.revokeAdmission();
  expect(await f.own(original.close())).toBe(false);
  const owned = mocks.launcher.mock.results[0]!.value;
  const returned = await owned;
  expect(returned.child.kill).toHaveBeenCalledTimes(1);
  expect(f.browser.close).toHaveBeenCalledTimes(1);
  expect(f.sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it('retains and detaches a late original browser session after admission revocation', async () => {
  const f = fixture({ holdBrowserSession: true }),
    opening = f.open();
  await f.sessionStarted;
  f.revokeAdmission();
  f.releaseSession();
  const error = await opening.then(
    () => {
      throw new Error('LATE_SESSION_ADMITTED');
    },
    (value) => value
  );
  expect(error).toMatchObject({ message: 'SUPERVISOR_ADMISSION_CLOSED' });
  f.accepted.add(error);
  expect(f.detachBrowserSession).toHaveBeenCalledTimes(1);
  expect(f.browser.close).toHaveBeenCalledTimes(1);
  expect(f.sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it('refuses a substituted close session even after the exact original attach was observed', async () => {
  const f = fixture({ substituteCloseSession: true }),
    original = await f.open();
  f.expectHeldClose();
  f.revokeAdmission();
  expect(await f.own(original.close())).toBe(false);
  expect(
    f.sockets[0]!.messages.filter((message) => message.method === 'Browser.close')
  ).toHaveLength(0);
  const returned = await mocks.launcher.mock.results[0]!.value;
  expect(returned.child.kill).toHaveBeenCalledTimes(1);
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});

it('captures a late returned original detach getter once and never substitutes the cleanup receiver', async () => {
  const f = fixture({ holdBrowserSession: true, replaceDetachAfterFirst: true }),
    opening = f.open();
  await f.sessionStarted;
  f.revokeAdmission();
  f.releaseSession();
  const error = await opening.then(
    () => {
      throw new Error('LATE_SESSION_ADMITTED');
    },
    (value) => value
  );
  expect(error).toMatchObject({ message: 'SUPERVISOR_ADMISSION_CLOSED' });
  f.accepted.add(error);
  expect(f.detachReads()).toBe(1);
  expect(f.detachBrowserSession).toHaveBeenCalledTimes(1);
  expect(f.replacementDetach).not.toHaveBeenCalled();
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});
