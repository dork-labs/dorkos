import {
  createOriginalBrowserViewerDiagnostic,
  type BrowserViewerDiagnosticStage,
} from '../stream/viewer-diagnostic.js';
import { BrokerError } from '../egress/broker/errors.js';
import { peekCanvasService } from '../../canvas/index.js';
import { AuthorRegistry } from '../../rooms/author-registry.js';
import { createBrowserCanvasScopeAdmission } from '../api/canvas-scope-admission.js';
import { BrowserCanvasAttachmentHost } from '../api/canvas-attachment-host.js';
import { BrowserCanvasAttachmentRoutes } from '../api/canvas-attachment-routes.js';
import type { RuntimeBrowserBirth } from './runtime-birth.js';
import { createManagedBrowserRuntimeTools } from './runtime-tools.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { createPrivateCapabilitySlots } from './private-capability-slots.js';
import { createAuthenticatedBrowserCapabilities } from './authenticated-capabilities.js';
import { createCapabilityArtifactRoot } from './capability-artifact-root.js';
import type { Db } from '@dorkos/db';
import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import { parseBrowserId, type BrowserResult } from '@dorkos/browser';
import type {
  BrowserBinding,
  BrowserGrant,
  BrowserInstance,
  BrowserOpenRequest,
} from '@dorkos/shared/browser-schemas';
import { Router } from 'express';
import type { Auth } from '../../core/auth/index.js';
import type { ConfigManager } from '../../core/config-manager.js';
import { BrowserApiService, type BrowserApiActor } from '../api/service.js';
import type { BrowserRegistryStore } from '../registry/store.js';
import { BrowserRegistry } from '../registry/registry.js';
import { OwnedBrowserGrants } from '../api/grants.js';
import { BrowserControllerInput } from '../api/controller-input.js';
import { BrowserControllerNavigation } from '../api/controller-navigation.js';
import { OwnedBrowserController } from '../api/controller.js';
import { BrowserControllerIdentities } from '../api/controller-auth.js';
import { BrowserControllerHost } from '../api/controller-host.js';
import { BrowserGrantScopeLoss } from '../api/grant-scope.js';
import { BrowserViewCapture } from '../stream/native-capture.js';
import { BrowserViewHost } from '../stream/view-host.js';
import { BrowserViewLossFanOut } from '../stream/loss-fan-out.js';
import { BrowserViewRoutes } from '../stream/view-routes.js';
import { BrowserInputRoutes } from '../api/input-routes.js';
import { createProductionLiveBrowserComposition } from '../egress/broker/live/production-composition.js';
import {
  captureProductionBrowserMode,
  type ProductionBrowserModeAdmission,
} from './startup-mode.js';

/** Declared original actor factory availability is metadata, never native birth or admission. */
export function hasProductionBrowserActorFactory(): boolean {
  return typeof createAuthenticatedBrowserCapabilities === 'function';
}

/** One exact production acquisition; the startup bank retains its handle before native open. */
export function createProductionBrowserSession(options: {
  db: Db;
  auth: Auth;
  config: ConfigManager;
  registry: BrowserRegistry;
  store: BrowserRegistryStore;
  inventory: Parameters<typeof createProductionLiveBrowserComposition>[0]['inventory'];
  admission: ProductionBrowserModeAdmission;
}) {
  const db = options.db,
    auth = options.auth,
    config = options.config,
    registry = options.registry,
    store = options.store,
    inventory = options.inventory,
    admission = options.admission;
  const mode = captureProductionBrowserMode(admission);
  const admissionDiagnostic = createOriginalBrowserViewerDiagnostic();
  const originals: (() => unknown | Promise<unknown>)[] = [];
  let closed = false,
    closing: Promise<void> | undefined;
  let grant:
    | Awaited<
        ReturnType<ReturnType<typeof createProductionLiveBrowserComposition>['authorizeWorkspace']>
      >
    | undefined;
  let acquired:
    | Awaited<ReturnType<ReturnType<typeof createProductionLiveBrowserComposition>['open']>>
    | undefined;
  type Opened = Readonly<{
    engine: BrowserLifecycleEngine;
    opened: Extract<BrowserResult, { kind: 'opened' }>;
    instance: BrowserInstance;
    binding: BrowserBinding;
  }>;
  let opening: Promise<Opened> | undefined;
  let runtimeOwner: RuntimeBrowserBirth | undefined;
  let runtimeGrant: Readonly<{ grantId: string; revision: number }> | undefined;
  let first: { reason: unknown } | undefined;
  const fail = (reason: unknown) => {
    first ??= { reason };
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    closed = true;
    let joined = 0;
    const enterRemaining = () => {
      const jobs: Promise<unknown>[] = [];
      while (joined < originals.length) {
        const original = originals[joined++]!;
        try {
          jobs.push(Promise.resolve(original()));
        } catch (reason) {
          fail(reason);
        }
      }
      return jobs;
    };
    // Enter all captured duties synchronously, then join the original opening before
    // draining any duty captured by a constructor that reentrantly closed the handle.
    const initial = enterRemaining();
    if (opening) initial.push(opening);
    void (async () => {
      let jobs = initial;
      do {
        for (const result of await Promise.allSettled(jobs))
          if (result.status === 'rejected') fail(result.reason);
        jobs = enterRemaining();
      } while (jobs.length || joined < originals.length);
      if (first) reject(first.reason);
      else resolve();
    })();
    return closing;
  };
  let closeInputLoss: (() => Promise<unknown>) | undefined;
  let preparingClose: Promise<void> | undefined;
  const prepareClose = (): Promise<void> => {
    if (preparingClose) return preparingClose;
    closed = true;
    preparingClose = Promise.resolve().then(async () => {
      try {
        await closeInputLoss?.();
      } catch (value) {
        fail(value);
        throw value;
      }
    });
    return preparingClose;
  };
  const retainClose = (
    receiver: object,
    name: string,
    before?: () => Promise<unknown> | undefined
  ) => {
    let ready!: (method: () => unknown) => void, refuse!: (value: unknown) => void;
    const captured = new Promise<() => unknown>((yes, no) => {
      ready = yes;
      refuse = no;
    });
    let entered: Promise<unknown> | undefined;
    const duty = () =>
      (entered ??= captured.then(async (method) => {
        let primary: { value: unknown } | undefined;
        try {
          if (before) await before();
        } catch (value) {
          primary = { value };
        }
        let result: unknown;
        try {
          result = await Reflect.apply(method, receiver, []);
        } catch (value) {
          primary ??= { value };
        }
        if (primary) throw primary.value;
        return result;
      }));
    originals.push(duty);
    void captured.catch(() => {});
    try {
      const method = (receiver as Record<string, unknown>)[name];
      if (typeof method !== 'function') throw new Error('BROWSER_CLOSE_UNAVAILABLE');
      ready(method as () => unknown);
    } catch (value) {
      refuse(value);
      throw value;
    }
    return duty;
  };
  let network!: ReturnType<typeof createProductionLiveBrowserComposition>;
  const admit = () => {
    if (closed || !mode.current()) {
      if (first) throw first.reason;
      throw new Error('BROWSER_UNAVAILABLE');
    }
  };
  const available = () => {
    let stage: BrowserViewerDiagnosticStage = 'session.closed';
    const refuse = () => {
      admissionDiagnostic.note(stage);
      return false;
    };
    try {
      if (closed) return refuse();
      stage = 'session.mode';
      if (!mode.current()) return refuse();
      stage = 'session.grant';
      if (!grant) return refuse();
      stage = 'session.acquired';
      if (!acquired) return refuse();
      stage = 'session.network';
      const admitted = network.isCurrent(grant);
      if (!admitted) admissionDiagnostic.note(stage);
      return admitted;
    } catch (value) {
      admissionDiagnostic.failure(stage, value);
      throw value;
    }
  };
  const router = Router();
  let control: BrowserControllerHost | undefined;
  let localDestination:
    ReturnType<typeof createProductionLiveBrowserComposition>['allowLocalDestination'] | undefined;
  let navigation: BrowserControllerNavigation | undefined;
  let api: BrowserApiService | undefined;
  let ownsTicket: ((token: string) => boolean) | undefined;
  let ownsAttachment: ((attachmentId: string) => boolean) | undefined;
  let toolSources:
    | (Pick<
        Parameters<typeof createManagedBrowserRuntimeTools>[0],
        'controller' | 'input' | 'engine'
      > & { grants: OwnedBrowserGrants })
    | undefined;
  let tools: ReturnType<typeof createManagedBrowserRuntimeTools> | undefined;
  let toolPrincipals: RuntimePrincipalService | undefined;
  let toolAuthors: AuthorRegistry | undefined;
  let capabilities:
    | Awaited<ReturnType<ReturnType<typeof createAuthenticatedBrowserCapabilities>['open']>>
    | undefined;
  return Object.freeze({
    prepareClose,
    close,
    router,
    /** Original production callers receive private hosts only after genuine engine birth and fresh mode admission. */
    capabilities() {
      if (!available() || !capabilities) throw new Error('BROWSER_UNAVAILABLE');
      return capabilities;
    },
    async open(
      headers: { cookie?: string },
      workspaceId: string,
      request: BrowserOpenRequest,
      signal: AbortSignal,
      initialUrl?: string,
      runtime?: RuntimeBrowserBirth,
      initialStorageState?: unknown
    ): Promise<
      Readonly<{
        engine: BrowserLifecycleEngine;
        opened: Extract<BrowserResult, { kind: 'opened' }>;
        instance: BrowserInstance;
        binding: BrowserBinding;
      }>
    > {
      if (closed || opening) throw new Error('BROWSER_UNAVAILABLE');
      let resolveOriginal!: (value: Opened) => void, rejectOriginal!: (value: unknown) => void;
      opening = new Promise<Opened>((yes, no) => {
        resolveOriginal = yes;
        rejectOriginal = no;
      });
      void opening.catch((reason) => {
        fail(reason);
        void close().catch(() => {});
      });
      try {
        if (!mode.current() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
        const addLoss = signal.addEventListener.bind(signal),
          removeLoss = signal.removeEventListener.bind(signal);
        const lost = () => {
          fail(signal.reason);
          void close().catch(() => {});
        };
        originals.push(() => removeLoss('abort', lost));
        addLoss('abort', lost, { once: true });
        if (signal.aborted) lost();
        if (closed) {
          if (first) throw first.reason;
          throw new Error('BROWSER_UNAVAILABLE');
        }
        void Promise.resolve()
          .then(async () => {
            runtimeOwner = runtime;
            if (
              runtime &&
              (request.mode !== 'ephemeral' ||
                runtime.workspaceId !== workspaceId ||
                runtime.actor.ownerId !== mode.ownerId ||
                !runtime.actor())
            )
              throw new Error('BROWSER_UNAVAILABLE');
            const canvasScope = createBrowserCanvasScopeAdmission(db, new AuthorRegistry(db));
            const grants = new OwnedBrowserGrants(
              registry,
              (actor, attachment) =>
                runtimeOwner
                  ? runtimeOwner.actor() &&
                    (((actor === runtimeOwner.recipientId || actor === mode.ownerId) &&
                      attachment.kind === 'session' &&
                      attachment.sessionId === runtimeOwner.sessionId) ||
                      canvasScope(actor, attachment)) &&
                    runtimeOwner.actor()
                  : canvasScope(actor, attachment),
              () => !closed && mode.current()
            );
            retainClose(grants, 'closeExpiry');
            admit();
            const input = new BrowserControllerInput();
            retainClose(input, 'close');
            admit();
            const raster = new BrowserViewCapture();
            retainClose(raster, 'close');
            admit();
            navigation = new BrowserControllerNavigation(input);
            retainClose(navigation, 'close');
            admit();
            const capabilitySlots = createPrivateCapabilitySlots();
            retainClose(capabilitySlots, 'close');
            const capabilityOwner = createAuthenticatedBrowserCapabilities();
            const artifactRoot = createCapabilityArtifactRoot();
            // Register root release before acquisition. Artifact/native duties must join before removal.
            originals.push(() => artifactRoot.close(capabilityOwner.close));
            admit();
            network = createProductionLiveBrowserComposition({
              db: db,
              auth: auth,
              config: config,
              inventory: inventory,
              policyRevision: mode.configuration.network.policyRevision,
              now: () => Number(process.hrtime.bigint() / 1000000n),
              engineConfiguration: mode.configuration,
            });
            retainClose(network, 'close', () => closeInputLoss?.());
            localDestination = network.allowLocalDestination.bind(network);
            admit();
            grant = runtime
              ? await network.authorizeRuntimeWorkspace(
                  runtime.principals,
                  runtime.principal,
                  workspaceId,
                  signal,
                  runtime.delegation,
                  runtime.ownerResolution
                )
              : await network.authorizeWorkspace(headers, workspaceId, signal);
            if (closed || !mode.current() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
            const original = await network.open(
              grant,
              { kind: 'open', ...request },
              Object.freeze({
                ...grants.birthOwner(
                  mode.ownerId,
                  request.mode === 'persistent'
                    ? Object.freeze({
                        mode: 'persistent',
                        profileId: request.profileId,
                      })
                    : Object.freeze({ mode: 'ephemeral' }),
                  undefined,
                  input.owner,
                  raster.owner
                ),
                bindEngine: grants.bindEngine.bind(grants),
                navigation: navigation.owner,
                ...(mode.resourceAcceptance ? { resources: mode.resourceAcceptance } : {}),
                upload: capabilitySlots.uploadOwner,
                download: capabilitySlots.downloadOwner,
                semantic: capabilitySlots.semanticOwner,
              }),
              initialStorageState
            );
            acquired = original;
            if (initialStorageState !== undefined) {
              // Initialization never publishes ordinary HTTP, actor, viewer or controller hosts.
              if (request.mode !== 'persistent' || !available() || signal.aborted)
                throw new Error('BROWSER_UNAVAILABLE');
              return Object.freeze({
                engine: original.engine,
                opened: original.opened,
                instance: store.project(
                  store.instance(
                    mode.ownerId,
                    original.opened.browserId,
                    original.opened.browserGeneration
                  )
                ),
                binding: original.opened.tab,
              });
            }
            if (initialUrl !== undefined) {
              admit();
              const navigate = network.navigate.bind(network);
              await navigate(grant, initialUrl, request.requestId);
              admit();
            }
            if (!available() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
            api = new BrowserApiService(registry, store, available, original.engine);
            const identities = new BrowserControllerIdentities();
            retainClose(identities, 'close');
            admit();
            const controller = new OwnedBrowserController(
              registry,
              original.engine,
              available,
              grants
            );
            const view = new BrowserViewHost(
              registry,
              original.engine,
              identities,
              grants,
              raster,
              available,
              mode.viewerSamples,
              mode.viewerSamples?.census?.({
                browserId: original.opened.browserId,
                browserGeneration: original.opened.browserGeneration,
              })
            );
            retainClose(view, 'close');
            admit();
            controller.bindNavigationViews(view);
            admit();
            ownsTicket = view.ownsTicket.bind(view);
            const scope = new BrowserGrantScopeLoss(grants);
            retainClose(scope, 'close');
            admit();
            const loss = new BrowserViewLossFanOut(view, controller, scope, grants, identities);
            closeInputLoss = retainClose(loss, 'prepareClose');
            retainClose(loss, 'close');
            admit();
            grants.bindController(loss);
            control = new BrowserControllerHost(controller, identities, grants, loss);
            input.bindHost(control);
            admit();
            toolSources = Object.freeze({
              grants,
              controller,
              input,
              engine: original.engine,
            });
            navigation.bindHost(control);
            navigation.bindActorController(controller);
            admit();
            const artifact = await artifactRoot.acquire();
            admit();
            capabilities = await capabilityOwner.open({
              engine: original.engine,
              identities,
              grants,
              controller: control,
              semanticController: controller,
              slots: capabilitySlots,
              enabled: available,
              artifactDirectory: artifact.directory,
              protectedRoots: [resolveDorkHome()],
            });
            admit();
            const views = new BrowserViewRoutes(view);
            retainClose(views, 'close');
            admit();
            const inputs = new BrowserInputRoutes(input, control, available);
            retainClose(inputs, 'close');
            admit();
            if (!available() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
            const canvas = peekCanvasService();
            if (canvas) {
              const presentation = new BrowserCanvasAttachmentHost(
                registry,
                grants,
                canvas,
                original.engine,
                createBrowserCanvasScopeAdmission(db, new AuthorRegistry(db))
              );
              retainClose(presentation, 'close');
              ownsAttachment = presentation.ownsAttachment.bind(presentation);
              admit();
              const presentationRoutes = new BrowserCanvasAttachmentRoutes(
                presentation,
                identities,
                available
              );
              retainClose(presentationRoutes, 'close');
              admit();
              router.use(presentationRoutes.router);
            }
            router.use(views.router);
            router.use(inputs.router);
            router.use(capabilities.semanticRouter);
            router.use(capabilities.diagnosticsRouter);
            router.use(capabilities.fileRouter);
            if (!available() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
            if (runtime) {
              if (!runtime.actor() || !available() || signal.aborted)
                throw new Error('BROWSER_UNAVAILABLE');
              const rows = original.engine.listTabs(
                original.opened.browserId,
                original.opened.browserGeneration
              );
              const binding = rows.find((value) => value.tabId === original.opened.tab.tabId);
              if (!binding || rows.length !== 1) throw new Error('BROWSER_UNAVAILABLE');
              const ownerCredential = Object.freeze({});
              const readOwner = () =>
                runtime.actor() && available()
                  ? { owner: mode.ownerId, credential: ownerCredential }
                  : undefined;
              const issued = grants.issue(
                readOwner,
                binding,
                runtime.recipientId,
                { kind: 'session', sessionId: runtime.sessionId },
                ['browser.view', 'browser.control'],
                runtime.expiresAt()
              );
              if (!readOwner() || signal.aborted) throw new Error('BROWSER_UNAVAILABLE');
              runtimeGrant = Object.freeze({
                grantId: issued.grantId,
                revision: issued.grantRevision,
              });
            }
            return Object.freeze({
              engine: original.engine,
              opened: original.opened,
              instance: registry.instance(
                mode.ownerId,
                original.opened.browserId,
                original.opened.browserGeneration
              ),
              binding: (() => {
                const tabs = original.engine.listTabs(
                  original.opened.browserId,
                  original.opened.browserGeneration
                );
                const actual = tabs.filter((tab) => tab.tabId === original.opened.tab.tabId);
                if (actual.length !== 1 || !available() || signal.aborted)
                  throw new Error('BROWSER_UNAVAILABLE');
                return Object.freeze({ ...actual[0]! });
              })(),
            });
          })
          .then(resolveOriginal, (reason) => {
            fail(reason);
            rejectOriginal(reason);
          });
      } catch (reason) {
        fail(reason);
        rejectOriginal(reason);
      }
      return opening;
    },
    /** The owner credential and native browser identity are original session participants. */
    allowLocalDestination(
      binding: BrowserBinding,
      endpoint: string,
      ttl: number,
      readOwner: (() => boolean) & { readonly ownerId: string },
      onOriginalDenial: (value: BrokerError) => void
    ) {
      const deny = () => {
        const original = new BrokerError('AUTHORITY_REFUSED');
        onOriginalDenial(original);
        return original;
      };
      if (first) throw first.reason;
      if (!readOwner() || readOwner.ownerId !== mode.ownerId || !available() || !localDestination)
        throw deny();
      if (!acquired) throw deny();
      const matches = acquired.engine
        .listTabs(binding.browserId, binding.browserGeneration)
        .filter((tab) => tab.tabId === binding.tabId);
      if (
        matches.length !== 1 ||
        ![
          'browserId',
          'browserGeneration',
          'tabId',
          'epoch',
          'inputGeneration',
          'navigationGeneration',
          'viewportVersion',
        ].every((key) => Reflect.get(matches[0]!, key) === Reflect.get(binding, key)) ||
        !readOwner() ||
        !available()
      )
        throw deny();
      const invoke = localDestination;
      invoke(
        {
          browserId: parseBrowserId(binding.browserId),
          browserGeneration: binding.browserGeneration,
        },
        endpoint,
        ttl,
        () => readOwner() && available(),
        onOriginalDenial
      );
      admit();
    },
    /** Private consumed owner decision supplies the live approval predicate; tool JSON supplies none. */
    issueRuntimeFileGrant(
      binding: BrowserBinding,
      permissions: BrowserGrant['permissions'],
      expiresAt: string,
      originalApprovalCurrent: () => boolean
    ): BrowserGrant {
      admit();
      const birth = runtimeOwner,
        capturedToolSources = toolSources;
      if (!birth || !birth.actor() || !available() || !capturedToolSources)
        throw new Error('BROWSER_UNAVAILABLE');
      const credential = Object.freeze({});
      const readOwner = () =>
        birth.actor() && available() ? { owner: mode.ownerId, credential } : undefined;
      const lifetime = capturedToolSources.grants.scopeOwner(originalApprovalCurrent);
      // Reserve cleanup before issuance callbacks can reenter session retirement.
      originals.push(() => lifetime.close());
      const issued = lifetime.issue(
        readOwner,
        binding,
        birth.recipientId,
        { kind: 'session', sessionId: birth.sessionId },
        permissions,
        expiresAt
      );
      if (!readOwner() || !originalApprovalCurrent() || !available()) {
        const closing = lifetime.close();
        void closing.catch(fail);
        throw new Error('BROWSER_UNAVAILABLE');
      }
      return issued;
    },
    /** Original recipient grant created only after a genuine independent runtime birth. */
    runtimeGrant() {
      if (!runtimeGrant || !runtimeOwner?.actor() || !available())
        throw new Error('BROWSER_UNAVAILABLE');
      return runtimeGrant;
    },
    current: available,
    async bindings(
      actor: () => BrowserApiActor | undefined,
      browserId: string,
      generation: number
    ) {
      if (!available() || !api || !navigation) throw new Error('BROWSER_UNAVAILABLE');
      await navigation.joinTransitions(browserId, generation);
      if (!available() || !api) throw new Error('BROWSER_UNAVAILABLE');
      return api.bindings(actor, browserId, generation);
    },
    identity() {
      return acquired
        ? Object.freeze({
            ownerId: mode.ownerId,
            browserId: acquired.opened.browserId,
            browserGeneration: acquired.opened.browserGeneration,
          })
        : undefined;
    },
    ownsAttachment(attachmentId: string) {
      return available() && ownsAttachment?.(attachmentId) === true;
    },
    ownsTicket(token: string) {
      return !closed && ownsTicket?.(token) === true;
    },
    navigation() {
      if (!available() || !navigation) throw new Error('BROWSER_UNAVAILABLE');
      return navigation;
    },
    /** Private runtime issuer uses original constructed participants and the actual server turn service. */
    runtimeTools(principals: RuntimePrincipalService, authors: AuthorRegistry) {
      admit();
      if (
        !available() ||
        !toolSources ||
        (toolPrincipals && toolPrincipals !== principals) ||
        (toolAuthors && toolAuthors !== authors)
      )
        throw new Error('BROWSER_UNAVAILABLE');
      if (!tools) {
        tools = createManagedBrowserRuntimeTools({
          ...toolSources,
          principals,
          authors,
          owners: runtimeOwner?.ownerResolution,
          actorCapabilities: capabilities,
          navigation,
          enabled: available,
        });
        toolPrincipals = principals;
        toolAuthors = authors;
        retainClose(tools, 'close');
      }
      admit();
      if (!available()) throw new Error('BROWSER_UNAVAILABLE');
      return tools;
    },
    controller() {
      if (!available() || !control) throw new Error('BROWSER_UNAVAILABLE');
      return control;
    },
    engine(): BrowserLifecycleEngine {
      if (!available() || !acquired) throw new Error('BROWSER_UNAVAILABLE');
      return acquired.engine;
    },
    binding(): BrowserBinding {
      if (!available() || !acquired) throw new Error('BROWSER_UNAVAILABLE');
      const tabs = acquired.engine.listTabs(
        acquired.opened.browserId,
        acquired.opened.browserGeneration
      );
      const actual = tabs.filter((tab) => tab.tabId === acquired!.opened.tab.tabId);
      if (actual.length !== 1 || !available()) throw new Error('BROWSER_UNAVAILABLE');
      return Object.freeze({ ...actual[0]! });
    },
  });
}
