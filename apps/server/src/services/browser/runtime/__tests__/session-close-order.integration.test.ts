import type { createControllerProxyAuthentication } from '../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';
type ConnectOverCDPTransport = Parameters<typeof createControllerProxyAuthentication>[0];
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Request, Response } from 'express';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserControllerIdentities } from '../../api/controller-auth.js';
import { authors, createDb, runMigrations } from '@dorkos/db';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserInputDispatcher,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import { parseBrowserId, parseTabId } from '../../../../../../../packages/browser/src/ids.js';
import { constructOwnedBrowserEngine } from '../../../../../../../packages/browser/src/server-owner.js';
import {
  configuration,
  fakePage,
  root,
  requestId,
} from '../../../../../../../packages/browser/src/__tests__/parent-fixture.js';
import { createProductionBrowserSession } from '../production-session.js';
import { joinProductionBrowserClose } from '../close-browser-join.js';
import { BrowserRegistry } from '../../registry/registry.js';
import { BrowserRegistryStore } from '../../registry/store.js';
import type { OwnedBrowserController } from '../../api/controller.js';
import { BrowserViewLossFanOut } from '../../stream/loss-fan-out.js';

const originals = vi.hoisted(() => ({
  mode: vi.fn(),
  home: undefined as string | undefined,
  network: vi.fn(),
  connect: vi.fn(),
  wire: vi.fn(),
  library: vi.fn(),
  processes: vi.fn(),
  journal: vi.fn(),
  supervisor: vi.fn(),
  host: vi.fn(),
  reserve: vi.fn(),
  proxy: vi.fn(),
  directory: vi.fn(),
  controller: undefined as OwnedBrowserController | undefined,
  identities: undefined as BrowserControllerIdentities | undefined,
  loss: undefined as BrowserViewLossFanOut | undefined,
  dispatcher: undefined as PrivateBrowserInputDispatcher | undefined,
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: () => {
    if (!originals.home) throw new Error('ORIGINAL_FIXTURE_HOME_NOT_ACQUIRED');
    return originals.home;
  },
}));
vi.mock('../startup-mode.js', () => ({
  captureProductionBrowserMode: originals.mode,
}));
vi.mock('../../egress/broker/live/production-composition.js', () => ({
  createProductionLiveBrowserComposition: originals.network,
}));
vi.mock(
  '../../../../../../../packages/browser/src/runtime/identity/supervisor-protocol-wire.js',
  () => ({
    createSupervisorProtocolWire: originals.wire,
  })
);
vi.mock('../../../../../../../packages/browser/src/runtime/public-library.js', () => ({
  verifiedLibrary: originals.library,
}));
vi.mock('../../../../../../../packages/browser/src/runtime/host-identity.js', () => ({
  hostIdentity: originals.host,
  nativeHolder: async () => root,
}));
vi.mock('../../../../../../../packages/browser/src/profiles/owned-directory.js', () => ({
  ownDirectory: originals.directory,
  assertDirectory: vi.fn(),
}));
vi.mock('../../../../../../../packages/browser/src/profiles/paths.js', () => ({
  prepareDataRoot: async () => '/fixture/close-data',
  privateDirectory: vi.fn(async () => {}),
}));
vi.mock('../../../../../../../packages/browser/src/profiles/reservation.js', () => ({
  reserveProfile: originals.reserve,
}));
vi.mock('../../../../../../../packages/browser/src/network/fixture-proxy.js', () => ({
  startFixtureProxy: originals.proxy,
}));
vi.mock('../../../../../../../packages/browser/src/runtime/darwin-engine-processes.js', () => ({
  createDarwinEngineProcesses: originals.processes,
}));
vi.mock('../../../../../../../packages/browser/src/runtime/darwin-engine-journal.js', () => ({
  startDarwinEngineJournal: originals.journal,
}));
vi.mock('../../../../../../../packages/browser/src/runtime/darwin-supervisor-client.js', () => ({
  startDarwinSupervisorClient: originals.supervisor,
}));
// Portable caller-posture doubles; the identity bank itself issues and retains
// the original local credential, and its real close triggers actual seat loss.
vi.mock('../../../../lib/caller-authority.js', () => ({
  readCallerAuthority: () => ({}),
}));
vi.mock('../../../core/approvals/decision-authority.js', () => ({
  resolveDecisionAuthority: () => ({ allowed: true, posture: 'local-trust' }),
}));
vi.mock('../../../../routes/room-caller.js', () => ({
  resolveCaller: () => ({ kind: 'human', id: 'close-owner' }),
}));
vi.mock('../../api/controller-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/controller-auth.js')>();
  return {
    ...actual,
    BrowserControllerIdentities: class extends actual.BrowserControllerIdentities {
      constructor(...args: ConstructorParameters<typeof actual.BrowserControllerIdentities>) {
        super(...args);
        originals.identities = this;
      }
    },
  };
});
vi.mock('../../api/controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/controller.js')>();
  return {
    ...actual,
    OwnedBrowserController: class extends actual.OwnedBrowserController {
      constructor(...args: ConstructorParameters<typeof actual.OwnedBrowserController>) {
        super(...args);
        originals.controller = this;
      }
    },
  };
});
vi.mock('../../stream/loss-fan-out.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stream/loss-fan-out.js')>();
  return {
    ...actual,
    BrowserViewLossFanOut: class extends actual.BrowserViewLossFanOut {
      constructor(...args: ConstructorParameters<typeof actual.BrowserViewLossFanOut>) {
        super(...args);
        originals.loss = this;
      }
    },
  };
});

// Actual session, registry/SQLite, engine ordinary-state/reset, controller seats and
// loss fan-out are consumed. Only SDK/process/network transport originals are portable
// doubles; no native cleanup/authentication qualification follows from these controls.
it.each([
  'reset-return',
  'reset-undefined',
  'registered-return',
  'registered-undefined',
  'registered-balanced-tab',
  'registered-chrome-birth',
  'registered-auth-ack',
  'registered-config-off',
  'registered-empty-catalog',
  'late-controller-false',
] as const)(
  'joins actual original seat reset before engine/registry retirement (%s)',
  async (scenario) => {
    const diagnosticRows: string[] = [];
    const diagnosticsRead = vi.fn(
      () => 'SUPERVISOR_UNCERTAIN: PROXY_AUTH_CHALLENGE_EXACT\nPRIVATE-AUTH-SECRET\n'
    );
    const diagnosticsGetter = vi.fn(() => diagnosticsRead);
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      diagnosticRows.push(String(value));
      // Optional publication must not change the actual successful supervisor return,
      // or replace an independent original reset failure, including undefined.
      throw scenario.endsWith('undefined') ? undefined : false;
    });
    onTestFinished(() => {
      sink.mockRestore();
    });
    const assertOriginalDiagnostic = () => {
      expect(diagnosticsGetter).toHaveBeenCalledOnce();
      expect(diagnosticsRead).toHaveBeenCalledOnce();
      expect(
        diagnosticRows.filter((value) =>
          value.startsWith('Browser original supervisor close diagnostic ')
        )
      ).toEqual([
        'Browser original supervisor close diagnostic {"state":"observed","rows":[{"source":"uncertainty","code":"PROXY_AUTH_CHALLENGE_EXACT"}]}\n',
      ]);
      expect(diagnosticRows.join('')).not.toContain('PRIVATE-AUTH-SECRET');
    };
    const bank: {
      home?: string;
      db?: ReturnType<typeof createDb>;
      closed: boolean;
      session?: ReturnType<typeof createProductionBrowserSession>;
      engine?: BrowserLifecycleEngine;
      opening?: Promise<unknown>;
      takeover?: Promise<unknown>;
      loss?: Promise<unknown>;
      closing?: Promise<void>;
      finishing?: Promise<void>;
      release?: () => void;
    } = { closed: false };
    let originalRetirement: PrivateBrowserRetirementReceiver['observation'] | undefined;
    const resetBindings: Awaited<ReturnType<BrowserLifecycleEngine['resetInput']>>[] = [];
    const pending: Promise<unknown>[] = [],
      expected = new Set<unknown>();
    const finish = () =>
      (bank.finishing ??= Promise.resolve().then(async () => {
        bank.closed = true;
        let first: { value: unknown } | undefined;
        try {
          bank.release?.();
        } catch (value) {
          first ??= { value };
        }
        const close = Promise.resolve().then(() => bank.session?.close());
        for (const result of await Promise.allSettled([close, ...pending]))
          if (result.status === 'rejected' && !expected.has(result.reason))
            first ??= { value: result.reason };
        try {
          bank.db?.$client.close();
        } catch (value) {
          first ??= { value };
        }
        try {
          if (bank.home) await rmdir(bank.home);
        } catch (value) {
          first ??= { value };
        } finally {
          if (originals.home === bank.home) originals.home = undefined;
        }
        if (first) throw first.value;
      }));
    onTestFinished(finish);
    // The real artifact owner validates this exact protected root. Provision an
    // exclusive canonical empty home, and remove it only after original joins.
    bank.home = await mkdtemp(join(await realpath(tmpdir()), 'original-session-home-'));
    originals.home = bank.home;
    const check = () => {
      if (bank.closed) throw new Error('ORIGINAL_FIXTURE_CLOSED');
    };
    const db = (bank.db = createDb(':memory:'));
    runMigrations(db);
    db.insert(authors)
      .values({
        id: 'close-owner',
        kind: 'human',
        naturalKey: 'fixture:close-owner',
        displayName: 'Original close owner',
        createdAt: new Date().toISOString(),
      })
      .run();
    const store = new BrowserRegistryStore(db, 'session-close-order'),
      registry = new BrowserRegistry(store, () => false);
    const profile = store.createProfile('close-owner', 'Original close profile');
    const p = fakePage(),
      callbacks = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(p.raw.mainFrame(), 'url', {
      value: () => 'about:blank',
    });
    Object.assign(p.raw, {
      url: () => p.raw.mainFrame().url(),
      route: vi.fn(async () => {}),
      unroute: vi.fn(async () => {}),
    });
    // Fixed original SDK protocol doubles support the actual navigation observer.
    const metadataListeners = new Map<string, Set<(...values: unknown[]) => void>>();
    const originalSend = p.session.send.getMockImplementation()!;
    Object.assign(p.session, {
      send: vi.fn(async (method: string, ...args: unknown[]) => {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'close-root-frame' } } };
        if (method === 'Page.enable') return {};
        return Reflect.apply(originalSend, p.session, [method, ...args]);
      }),
      on(name: string, listener: (...values: unknown[]) => void) {
        const entries = metadataListeners.get(name) ?? new Set();
        entries.add(listener);
        metadataListeners.set(name, entries);
        return p.session;
      },
      off(name: string, listener: (...values: unknown[]) => void) {
        metadataListeners.get(name)?.delete(listener);
        return p.session;
      },
    });
    let nativeClosed = false,
      resetFaultArmed = false;
    const nativeBank: {
      supervisorReturned: boolean;
      journalReturned: boolean;
      prepared: boolean;
      attributed: boolean;
      forwarded: boolean;
      closing?: Promise<Readonly<{ pending: boolean; uncertain: boolean }>>;
    } = {
      supervisorReturned: false,
      journalReturned: false,
      prepared: false,
      attributed: false,
      forwarded: false,
    };
    type OriginalContext = ReturnType<typeof p.page.context>;
    type OriginalBrowser = NonNullable<ReturnType<OriginalContext['browser']>>;
    const managerIdentity = Object.freeze({
      pid: process.pid,
      birth: 'MOCK_MANAGER',
    });
    const supervisorIdentity = Object.freeze({
      pid: 42,
      birth: 'MOCK_SUPERVISOR',
    });
    const prepareClose = vi.fn(async () => {
      if (!nativeBank.attributed || nativeBank.supervisorReturned)
        throw new Error('ORIGINAL_JOURNAL_PRECLOSE_REFUSED');
      nativeBank.prepared = true;
    });
    const rootReturned = vi.fn(async (identity: typeof root) => {
      expect(identity).toEqual(root);
      if (!nativeBank.prepared || nativeBank.forwarded)
        throw new Error('ORIGINAL_ROOT_RETURN_REFUSED');
      nativeBank.forwarded = true;
    });
    const journalStop = vi.fn(async () => {
      if (!nativeBank.forwarded || !nativeBank.supervisorReturned)
        throw new Error('ORIGINAL_JOURNAL_STOP_REFUSED');
      nativeBank.journalReturned = true;
      return 'recorded-gone' as const;
    });
    originals.processes.mockReset().mockReturnValue(
      Object.freeze({
        identity: async () => managerIdentity,
        holder: async () => root,
        attributeRoot: async (parent: typeof root, child: typeof root) =>
          (parent.pid === managerIdentity.pid && child.pid === supervisorIdentity.pid) ||
          (parent.pid === supervisorIdentity.pid && child.pid === root.pid),
        processes: {
          descendants: async () => ({ status: 'complete', identities: [root] }),
          observe: async () => ({
            status: nativeBank.supervisorReturned ? 'dead' : 'alive',
          }),
        },
        observeTerminated: async () => ({
          status: nativeBank.supervisorReturned ? 'dead' : 'alive',
        }),
      })
    );
    originals.journal.mockReset().mockImplementation(async (options: { binding: object }) =>
      Object.freeze({
        binding: options.binding,
        attributeRoot: async (identity: typeof root, supervisor: typeof root) => {
          expect(identity).toEqual(root);
          expect(supervisor).toEqual(supervisorIdentity);
          nativeBank.attributed = true;
        },
        prepareClose,
        rootReturned,
        stop: journalStop,
        historyGapped: () => false,
        custody: () => ({
          pending: !nativeBank.journalReturned,
          uncertain: false,
        }),
      })
    );
    const originalControllerFailure = vi.fn();
    let releaseController!: () => void;
    const controllerAcquisition = new Promise<void>((resolve) => {
      releaseController = resolve;
    });
    if (scenario === 'late-controller-false') bank.release = releaseController;
    let sdkTransport: ConnectOverCDPTransport | undefined;
    let originalWireOpened = false,
      originalWireClosed = false;
    let heldAuthenticationReply: (() => void) | undefined;
    const originalSDKEvents: unknown[] = [];
    const originalAuthenticationCommands: Record<string, unknown>[] = [];
    const originalWire: ConnectOverCDPTransport = {
      open() {
        originalWireOpened = true;
      },
      send(message) {
        const command = message as Record<string, unknown>;
        if (command.method === 'Target.getBrowserContexts') {
          originalWire.onmessage?.({
            id: command.id,
            result: { browserContextIds: [], defaultBrowserContextId: 'original-default-context' },
          });
          return;
        }
        if (command.method === 'Target.getTargets') {
          originalWire.onmessage?.({
            id: command.id,
            result: {
              targetInfos:
                scenario === 'registered-empty-catalog'
                  ? []
                  : [
                      {
                        targetId: 'original-controller-page',
                        type: 'page',
                        url: 'about:blank',
                        browserContextId: 'original-default-context',
                      },
                      {
                        targetId: 'original-controller-service-worker',
                        type: 'service_worker',
                        url: 'https://original.example/worker.js',
                        browserContextId: 'original-default-context',
                      },
                    ],
            },
          });
          return;
        }
        expect(command.method).toBe('Fetch.continueWithAuth');
        originalAuthenticationCommands.push(command);
        const reply = () =>
          originalWire.onmessage?.({
            id: command.id,
            sessionId: command.sessionId,
            result: {},
          });
        if (scenario === 'registered-auth-ack') heldAuthenticationReply = reply;
        else reply();
      },
      close: async () => {
        originalWireClosed = true;
        originalWire.onclose?.('original-controller-terminal');
      },
    };
    originals.wire.mockReset().mockImplementation((endpoint: string) => {
      expect(endpoint).toBe(
        'ws://127.0.0.1:9003/devtools/browser/00000000-0000-4000-8000-000000000001'
      );
      if (!nativeBank.attributed) throw new Error('ORIGINAL_WIRE_BEFORE_ENROLLMENT');
      return Object.freeze({
        transport: originalWire,
        open: async () => originalWire.open?.(),
        close: originalWire.close.bind(originalWire),
        isKnown: () => originalWireOpened && !originalWireClosed,
      });
    });
    const supervisorStopEntered = vi.fn();
    const originalBrowser = {
      on: vi.fn(),
      off: vi.fn(),
      contexts: (): OriginalContext[] => [context as unknown as OriginalContext],
      close: vi.fn(async () => {
        if (!nativeBank.prepared) throw new Error('ORIGINAL_CDP_CLOSE_BEFORE_BARRIER');
        await sdkTransport?.close();
      }),
    };
    const context = {
      browser: (): OriginalBrowser => originalBrowser as unknown as OriginalBrowser,
      pages: () => [p.page],
      newPage: async () => p.page,
      on: (name: string, callback: (...args: unknown[]) => void) => {
        callbacks.set(name, callback);
      },
      close: vi.fn(async () => {
        if (!nativeBank.prepared) throw new Error('ORIGINAL_CONTEXT_CLOSE_BEFORE_BARRIER');
        nativeClosed = true;
        callbacks.get('close')?.();
      }),
    };
    Object.assign(p.raw, { setViewportSize: vi.fn(async () => {}) });
    originals.connect.mockReset().mockImplementation(async (transport: ConnectOverCDPTransport) => {
      if (!nativeBank.attributed) throw new Error('ORIGINAL_CDP_BEFORE_ENROLLMENT');
      expect(transport).not.toBe(originalWire);
      sdkTransport = transport;
      transport.onmessage = (message) => originalSDKEvents.push(message);
      transport.onclose = vi.fn();
      transport.open?.();
      const attachment = {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'original-controller-session',
          targetInfo: {
            targetId: 'original-controller-page',
            type: 'page',
            url: 'about:blank',
            browserContextId: 'original-default-context',
          },
          waitingForDebugger: false,
        },
      };
      originalWire.onmessage?.(attachment);
      expect(originalSDKEvents).toContain(attachment);
      if (scenario === 'late-controller-false') {
        await controllerAcquisition;
        originalControllerFailure(false);
        throw false;
      }
      return originalBrowser;
    });
    originals.supervisor
      .mockReset()
      .mockImplementation(
        async (
          _options: unknown,
          _failure: () => void,
          forward: (identity: typeof root) => Promise<void>
        ) =>
          Object.freeze({
            get diagnostics() {
              return diagnosticsGetter();
            },
            reportedRoot: root,
            reportedSupervisor: supervisorIdentity,
            reportedProxyURL: 'http://127.0.0.1:9002',
            reportedEndpointURL:
              'ws://127.0.0.1:9003/devtools/browser/00000000-0000-4000-8000-000000000001',
            close: () =>
              (nativeBank.closing ??= Promise.resolve().then(async () => {
                supervisorStopEntered();
                if (!nativeBank.prepared)
                  throw new Error('ORIGINAL_SUPERVISOR_CLOSE_BEFORE_BARRIER');
                await context.close();
                await forward(root);
                nativeBank.supervisorReturned = true;
                return Object.freeze({ pending: false, uncertain: false });
              })),
            custody: () => ({
              pending: !nativeBank.supervisorReturned,
              uncertain: false,
            }),
          })
      );
    originals.host.mockReset().mockReturnValue(root);
    originals.directory
      .mockReset()
      .mockImplementation((path: string) => ({ path, dev: 1, ino: 1 }));
    originals.reserve.mockReset().mockResolvedValue({
      profileDir: '/fixture/close-profile',
      nonce: 'original_close_reservation_nonce',
      release: async () => {},
      recordJournal: vi.fn(),
      recordFailure: vi.fn(),
      beginLaunch: vi.fn(),
      recordBrowser: vi.fn(),
    });
    originals.proxy.mockReset().mockResolvedValue({
      url: 'http://127.0.0.1:9002',
      close: async () => {},
    });
    originals.library.mockReset().mockImplementation(async (runtime) => {
      expect(runtime.identity.mode).toBe('native');
      return { connectOverCDP: originals.connect };
    });
    const config = configuration();
    const originalNativeRuntime = structuredClone(config.runtime);
    if (scenario === 'registered-chrome-birth') config.runtime.identity.mode = 'chrome-compatible';
    config.network = {
      kind: 'owned',
      origin: 'about:blank',
      policyRevision: 1,
    };
    config.nativeJournal = {
      workerPath: '/fixture/original-journal-worker.js',
      browserWorkerPath: '/fixture/original-browser-worker.js',
      artifact: { path: '/fixture/original-observer', sha256: '0'.repeat(64) },
      duration: 10000,
      maxGap: 1000,
    };
    const peer = Object.freeze({
      url: 'http://127.0.0.1:9002',
      credentials: Object.freeze({
        username: 'dorkos',
        password: 'fixture-only',
      }),
      isCustodyKnown: () => true,
      close: async () => {},
    });
    originals.mode.mockReset().mockReturnValue({
      ownerId: 'close-owner',
      current: () => true,
      configuration: { network: { policyRevision: 1 } },
    });
    const nativeClose = vi.fn(async () => {
      const results = await bank.engine!.shutdown();
      if (results.some((value) => value.cleanup !== 'observed'))
        throw new Error('ORIGINAL_ENGINE_CLOSE_UNVERIFIED');
    });
    originals.network.mockReset().mockReturnValue({
      // Local-site approval is outside this control; unexpected use must refuse.
      allowLocalDestination: () => {
        throw new Error('UNEXPECTED_LOCAL_DESTINATION_ENTRY');
      },
      close: nativeClose,
      isCurrent: () => !nativeClosed,
      authorizeWorkspace: async () => Object.freeze({}),
      async open(
        _grant: unknown,
        command: unknown,
        participant: Parameters<typeof constructOwnedBrowserEngine>[1] & {
          bindEngine(engine: BrowserLifecycleEngine): void;
        }
      ) {
        const input = participant.input!;
        const register = input.registerDispatcher.bind(input);
        const engine = (bank.engine = constructOwnedBrowserEngine(config, {
          ...participant,
          ...(scenario === 'registered-balanced-tab'
            ? {
                registerBirth(
                  receiver: Parameters<
                    Parameters<typeof constructOwnedBrowserEngine>[1]['registerBirth']
                  >[0]
                ) {
                  originalRetirement = receiver.observation;
                  pending.push(originalRetirement);
                  participant.registerBirth(receiver);
                },
              }
            : {}),
          network: {
            bindBeforeLaunch: async () => peer,
            activateReady: async () => {},
          },
          input: {
            registerDispatcher(value) {
              originals.dispatcher = value;
              register(value);
            },
          },
        }));
        // The real engine is frozen. This immutable consumed view delegates every
        // original method with its original receiver; only reset completion injects
        // the exact negative fault. Native shutdown remains owned by bank.engine.
        const reset = engine.resetInput.bind(engine);
        const delegated: BrowserLifecycleEngine = Object.freeze({
          open: engine.open.bind(engine),
          listTabs: engine.listTabs.bind(engine),
          capture: engine.capture.bind(engine),
          diagnostics: engine.diagnostics.bind(engine),
          input: engine.input.bind(engine),
          close: engine.close.bind(engine),
          shutdown: engine.shutdown.bind(engine),
          resetInput: async (binding: unknown) => {
            const result = await reset(binding);
            if (scenario === 'registered-balanced-tab') resetBindings.push(result);
            if (scenario.endsWith('undefined') && resetFaultArmed) throw undefined;
            return result;
          },
        });
        participant.bindEngine(delegated);
        const opened = await engine.open(command);
        if (opened.kind !== 'opened') throw new Error('ORIGINAL_ENGINE_OPEN_REFUSED');
        return {
          engine: delegated,
          opened,
          binding: engine.listTabs(opened.browserId, opened.browserGeneration)[0]!,
        };
      },
    });
    bank.session = createProductionBrowserSession({
      db,
      registry,
      store,
      admission: { kind: 'production-browser-mode' },
    } as Parameters<typeof createProductionBrowserSession>[0]);
    const opening = (bank.opening = bank.session.open(
      {},
      'close-workspace',
      { requestId, mode: 'persistent', profileId: profile.profileId },
      new AbortController().signal
    ));
    pending.push(opening);
    if (scenario === 'late-controller-false') {
      expected.add(false);
      let acquisitionReturned = false;
      void opening.then(
        () => {
          acquisitionReturned = true;
        },
        () => {
          acquisitionReturned = true;
        }
      );
      await vi.waitFor(() => expect(originals.connect).toHaveBeenCalledOnce());
      const closing = (bank.closing = bank.session.close());
      pending.push(closing);
      void closing.catch(() => {});
      await vi.waitFor(() => expect(originalWireClosed).toBe(true));
      expect(acquisitionReturned).toBe(false);
      releaseController();
      const openingOutcome = await opening.then(
        () => ({ rejected: false as const }),
        (value: unknown) => ({ rejected: true as const, value })
      );
      expect(originalControllerFailure).toHaveBeenCalledExactlyOnceWith(false);
      expect(openingOutcome).toMatchObject({
        rejected: true,
        value: { code: 'OPEN_FAILED', cleanupCode: 'observationUnavailable' },
      });
      if (openingOutcome.rejected) expected.add(openingOutcome.value);
      for (const returned of await Promise.allSettled([closing]))
        if (returned.status === 'rejected') expected.add(returned.reason);
      expect(originalWireOpened).toBe(true);
      expect(originalWireClosed).toBe(true);
      await finish();
      return;
    }
    const opened = await opening;
    check();
    if (scenario === 'registered-chrome-birth') {
      const seed = originals.supervisor.mock.calls[0]![0] as Parameters<
        typeof import('../../../../../../../packages/browser/src/runtime/darwin-supervisor-client.js').startDarwinSupervisorClient
      >[0];
      expect(seed.runtime.identity.mode).toBe('chrome-compatible');
      expect(seed.identityPreparation?.nativeRuntime).toEqual(originalNativeRuntime);
      expect(seed.identityPreparation?.nativeRuntime).toBe(originals.library.mock.calls[0]![0]);
      expect(seed.ownedProxy).toEqual({ url: peer.url, credentials: peer.credentials });
    } else expect(originals.supervisor.mock.calls[0]![0].identityPreparation).toBeUndefined();

    const registered = scenario.startsWith('registered-');
    const identities = originals.identities!;
    const req = { headers: {} } as Request,
      res = { locals: {} } as Response;
    const auth = registered
      ? identities.capture(req, res, identities.issueLocal(req, res))
      : undefined;
    const refreshing = auth?.refresh();
    if (refreshing) pending.push(refreshing);
    const actor = refreshing
      ? await refreshing
      : {
          owner: 'close-owner',
          credential: Object.freeze({}),
          controllerIdentity: Object.freeze({}),
        };
    check();
    const actorReader = auth?.current ?? (() => actor);
    const controller = originals.controller!,
      loss = originals.loss!;
    const takeover = (bank.takeover = controller.takeover(actorReader, opened.binding));
    pending.push(takeover);
    const seat = await takeover;
    check();
    expect(seat.status).toBe('ready');
    if (scenario === 'registered-balanced-tab') {
      // Real original queue/controller/identity/retirement composition. Only the existing
      // SDK/process ports are doubled; no reset/ledger/close result is fabricated here.
      const authorization = controller.authorization(actorReader, seat.binding, seat.controllerId!);
      const balanced = originals.dispatcher!.input(
        {
          kind: 'input',
          requestId,
          binding: {
            ...seat.binding,
            browserId: parseBrowserId(seat.binding.browserId),
            tabId: parseTabId(seat.binding.tabId),
          },
          steps: [
            { kind: 'keyDown', key: 'Tab' },
            { kind: 'keyUp', key: 'Tab' },
          ],
        },
        authorization
      );
      pending.push(balanced);
      expect((await balanced).outcome).toBe('completed');
      expect(p.raw.keyboard.down).toHaveBeenCalledExactlyOnceWith('Tab');
      expect(p.raw.keyboard.up).toHaveBeenCalledExactlyOnceWith('Tab');
      const closing = (bank.closing = joinProductionBrowserClose(
        () => bank.session!.close(),
        () => registry.stop(actor.owner, opened.opened.browserId, opened.opened.browserGeneration)
      ));
      pending.push(closing);
      await closing;
      expect(resetBindings).toHaveLength(2);
      expect(resetBindings.every((value) => value.status === 'ready')).toBe(true);
      expect(resetBindings[0]!.binding).toEqual({
        ...opened.binding,
        epoch: opened.binding.epoch + 1,
        inputGeneration: opened.binding.inputGeneration + 1,
      });
      expect(resetBindings[1]!.binding).toEqual({
        ...opened.binding,
        epoch: opened.binding.epoch + 2,
        inputGeneration: opened.binding.inputGeneration + 2,
      });
      const retired = await originalRetirement!;
      expect(retired.cleanup).toMatchObject({
        state: 'settled',
        coverage: 'closed',
        pending: false,
        uncertainty: [],
      });
      expect(retired.terminal).toEqual({ cleanup: 'observed' });
      expect(retired.owners).toHaveLength(1);
      expect(retired.owners[0]!.observation).toMatchObject({
        state: 'settled',
        binding: resetBindings[1]!.binding,
        pending: false,
        uncertainty: false,
      });
      expect(auth!.current()).toBeUndefined();
      expect(p.raw.keyboard.up).toHaveBeenCalledExactlyOnceWith('Tab');
      expect(nativeClose).toHaveBeenCalledOnce();
      expect(
        registry.instance(actor.owner, opened.opened.browserId, opened.opened.browserGeneration)
          .status
      ).toBe('stopped');
      await finish();
      assertOriginalDiagnostic();
      return;
    }
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    bank.release = () => {
      release();
      heldAuthenticationReply?.();
    };
    const keyboardUp = p.raw.keyboard.up.getMockImplementation()!,
      released = vi.fn();
    const authorization = controller.authorization(actorReader, seat.binding, seat.controllerId!);
    const pressing = originals.dispatcher!.input(
      {
        kind: 'input',
        requestId,
        binding: {
          ...seat.binding,
          browserId: parseBrowserId(seat.binding.browserId),
          tabId: parseTabId(seat.binding.tabId),
        },
        steps: [{ kind: 'keyDown', key: 'Shift' }],
      },
      authorization
    );
    pending.push(pressing);
    expect((await pressing).outcome).toBe('completed');
    check();
    p.raw.keyboard.up.mockImplementation(async (...args) => {
      released();
      await held;
      return keyboardUp(...args);
    });
    if (scenario === 'registered-auth-ack') {
      const paused = {
        method: 'Fetch.requestPaused',
        sessionId: 'original-controller-session',
        params: { requestId: 'original-route-pause', networkId: 'original-route-network' },
      };
      originalWire.onmessage?.(paused);
      expect(originalSDKEvents).toContain(paused);
      const challenge = {
        method: 'Fetch.authRequired',
        sessionId: 'original-controller-session',
        params: {
          requestId: 'original-proxy-challenge',
          authChallenge: { source: 'Proxy', origin: peer.url },
        },
      };
      originalWire.onmessage?.(challenge);
      expect(originalSDKEvents).not.toContain(challenge);
      expect(originalAuthenticationCommands).toEqual([
        expect.objectContaining({
          method: 'Fetch.continueWithAuth',
          sessionId: 'original-controller-session',
          params: {
            requestId: 'original-proxy-challenge',
            authChallengeResponse: { response: 'ProvideCredentials', ...peer.credentials },
          },
        }),
      ]);
    }
    resetFaultArmed = true;
    const retiring = registered
      ? undefined
      : (bank.loss = loss.revokeController(actor.controllerIdentity));
    if (retiring) {
      pending.push(retiring);
      void retiring.catch(() => {});
    }
    // The compatibility branch lets this same control expose the old producer ordering,
    // rather than failing because the newly introduced private method is absent.
    const originalPreparation =
      scenario === 'registered-config-off'
        ? ((bank.session as { prepareClose?: () => Promise<void> }).prepareClose?.() ??
          Promise.resolve())
        : Promise.resolve();
    if (scenario === 'registered-config-off') pending.push(originalPreparation);
    const closing = (bank.closing = originalPreparation.then(() => {
      if (scenario === 'registered-config-off')
        registry.stop(actor.owner, opened.opened.browserId, opened.opened.browserGeneration);
      return joinProductionBrowserClose(
        () => bank.session!.close(),
        () => registry.stop(actor.owner, opened.opened.browserId, opened.opened.browserGeneration)
      );
    }));
    pending.push(closing);
    void closing.catch(() => {});
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.waitFor(() => expect(released).toHaveBeenCalled());
    check();
    expect(settled).toBe(false);
    // The actual network/native close cannot fence listTabs while original seat reset is entered.
    expect(nativeClose).not.toHaveBeenCalled();
    expect(
      registry.instance(actor.owner, opened.opened.browserId, opened.opened.browserGeneration)
        .status
    ).toBe('running');
    release();
    if (scenario === 'registered-auth-ack') {
      await vi.waitFor(() => expect(nativeBank.prepared).toBe(true));
      expect(supervisorStopEntered).not.toHaveBeenCalled();
      expect(originalWireClosed).toBe(false);
      expect(settled).toBe(false);
      expect(heldAuthenticationReply).toBeTypeOf('function');
      heldAuthenticationReply!();
    }
    if (scenario.endsWith('undefined')) {
      expected.add(undefined);
      if (retiring) await expect(retiring).rejects.toBeUndefined();
      await expect(closing).rejects.toBeUndefined();
    } else {
      await retiring;
      await closing;
      expect(
        registry.instance(actor.owner, opened.opened.browserId, opened.opened.browserGeneration)
          .status
      ).toBe('stopped');
    }
    if (registered) expect(auth!.current()).toBeUndefined();
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(originalBrowser.close).toHaveBeenCalledOnce();
    expect(originals.connect).toHaveBeenCalledOnce();
    expect(originalWireOpened).toBe(true);
    expect(originalWireClosed).toBe(true);
    expect(originals.supervisor).toHaveBeenCalledOnce();
    expect(prepareClose).toHaveBeenCalledOnce();
    expect(rootReturned).toHaveBeenCalledOnce();
    expect(journalStop).toHaveBeenCalledOnce();
    expect(nativeBank.supervisorReturned).toBe(true);
    expect(nativeBank.journalReturned).toBe(true);
    expect(settled).toBe(true);
    await finish();
    assertOriginalDiagnostic();
  }
);

// The reset prerequisite must not join held native capture before the native close
// that is needed to interrupt it. Full capture closure still owns its original join.
it.each(['reset-return', 'reset-undefined'] as const)(
  'joins seat reset while leaving original capture closure independently held (%s)',
  async (scenario) => {
    const bank: {
      owner?: BrowserViewLossFanOut;
      preparing?: Promise<void>;
      complete?: Promise<void>;
      loss?: Promise<void>;
      finishing?: Promise<void>;
      reentrant?: Promise<void>;
      releaseReset?: () => void;
      releaseView?: () => void;
    } = {};
    const expected = new Set<unknown>();
    const finish = () =>
      (bank.finishing ??= Promise.resolve().then(async () => {
        bank.releaseReset?.();
        bank.releaseView?.();
        const closing = Promise.resolve().then(() => bank.owner?.close());
        let first: { value: unknown } | undefined;
        for (const result of await Promise.allSettled([
          closing,
          bank.preparing,
          bank.complete,
          bank.loss,
          bank.reentrant,
        ]))
          if (result.status === 'rejected' && !expected.has(result.reason))
            first ??= { value: result.reason };
        if (first) throw first.value;
      }));
    onTestFinished(finish);
    const resetHeld = new Promise<void>((yes) => {
      bank.releaseReset = yes;
    });
    const viewHeld = new Promise<void>((yes) => {
      bank.releaseView = yes;
    });
    const originalReset = vi.fn(async () => {
      await resetHeld;
      if (scenario === 'reset-undefined') throw undefined;
    });
    const viewClose = vi.fn(() => viewHeld),
      scopeClose = vi.fn(),
      grantClose = vi.fn();
    const identityClose = vi.fn(() => {
      bank.reentrant = bank.owner!.prepareClose();
      bank.loss = bank.owner!.revokeController(Object.freeze({}));
      void bank.loss.catch(() => {});
      return bank.loss;
    });
    bank.owner = new BrowserViewLossFanOut(
      { identityLost: vi.fn(), grantLost: vi.fn(), close: viewClose },
      { revokeController: originalReset, revokeGrant: vi.fn(async () => {}) },
      { close: scopeClose },
      { closeExpiry: grantClose },
      { close: identityClose }
    );
    bank.preparing = bank.owner.prepareClose();
    void bank.preparing.catch(() => {});
    let fullReturned = false,
      resetReturned = false;
    void bank.preparing.then(
      () => {
        resetReturned = true;
      },
      () => {
        resetReturned = true;
      }
    );
    await vi.waitFor(() => expect(originalReset).toHaveBeenCalledOnce());
    bank.complete = bank.owner.close();
    void bank.complete.catch(() => {});
    void bank.complete.then(
      () => {
        fullReturned = true;
      },
      () => {
        fullReturned = true;
      }
    );
    expect(bank.reentrant).toBe(bank.preparing);
    expect(resetReturned).toBe(false);
    expect(fullReturned).toBe(false);
    if (scenario === 'reset-undefined') expected.add(undefined);
    bank.releaseReset!();
    if (scenario === 'reset-undefined') await expect(bank.preparing).rejects.toBeUndefined();
    else await bank.preparing;
    expect(fullReturned).toBe(false);
    expect(viewClose).toHaveBeenCalledOnce();
    expect(scopeClose).toHaveBeenCalledOnce();
    expect(grantClose).toHaveBeenCalledOnce();
    expect(identityClose).toHaveBeenCalledOnce();
    bank.releaseView!();
    if (scenario === 'reset-undefined') await expect(bank.complete).rejects.toBeUndefined();
    else await bank.complete;
    await finish();
  }
);
