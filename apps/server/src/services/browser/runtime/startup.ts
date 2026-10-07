import type { MeasuredBrowserResourceAdmission } from './admission/measured-resource.js';
import { mintBrowserIdentityChoicePermit } from './activation/identity-choice-permit.js';
import { readOriginalProcessNativeProjection } from './private-native-projection.js';
import { readPrivateBrowserAcceptance } from './private-acceptance.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { ManagedBrowserCapabilityDeps } from './browser-capabilities.js';
import { observeOriginalStartupPhase } from './original-phase-diagnostic.js';
import { Router, type Express } from 'express';
import type { Server } from 'node:http';
import type { Db } from '@dorkos/db';
import type { Auth } from '../../core/auth/index.js';
import type { ConfigManager } from '../../core/config-manager.js';
import {
  BrowserProductionStatusSchema,
  type BrowserProductionStatus,
} from '@dorkos/shared/browser-schemas';
import { createProductionBrowserServerInventory } from './production-inventory.js';
import {
  createActivationAuthentication,
  isOriginalActivationRefusal,
} from './activation/activation-auth.js';
import { createBrowserActivationRoutes } from './activation/activation-routes.js';

/** Passive listener + owner-authenticated lifecycle remain available Off; native imports do not. */
export function createExperimentalBrowserStartup(
  options: {
    measuredResources?: MeasuredBrowserResourceAdmission;
  } = {}
) {
  const measuredResources = options.measuredResources;
  const privateBrowserAcceptance = readPrivateBrowserAcceptance();
  const privateProjection = privateBrowserAcceptance
    ? undefined
    : readOriginalProcessNativeProjection();
  const privateObservers = privateBrowserAcceptance ?? privateProjection;
  let stopped = false,
    epoch = 0,
    work: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  let failure: Readonly<{ value: unknown }> | undefined;
  const jobs = new Set<Promise<unknown>>(),
    duties = new Set<() => Promise<void>>();
  const localRefusals = new WeakSet<object>();
  const known = new Set<(reason: unknown) => boolean>([isOriginalActivationRefusal]);
  const expected = (reason: unknown) =>
    (typeof reason === 'object' && reason !== null && localRefusals.has(reason)) ||
    [...known].some((check) => check(reason));
  const refuse = () => {
    const reason = new Error('BROWSER_ACTIVATION_REFUSED');
    localRefusals.add(reason);
    return reason;
  };
  const fail = (value: unknown) => {
    failure ??= { value };
  };
  const guard = () => {
    if (stopped || failure) throw failure ? failure.value : refuse();
  };
  const retain = <T>(original: Promise<T>): Promise<T> => {
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        if (!expected(value)) fail(value);
        jobs.delete(original);
      }
    );
    return original;
  };
  const bankClose = (receiver: object): (() => Promise<void>) => {
    let resolve!: (method: () => Promise<void>) => void, reject!: (value: unknown) => void;
    const ready = new Promise<() => Promise<void>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void ready.catch(() => {});
    let original: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (original) return original;
      original = retain(ready.then((method) => Reflect.apply(method, receiver, [])));
      void original.then(
        () => duties.delete(close),
        () => duties.delete(close)
      );
      return original;
    };
    duties.add(close); // Duty precedes the fallible original method getter.
    try {
      const method = (receiver as { close?: unknown }).close;
      if (typeof method !== 'function') throw refuse();
      resolve(method as () => Promise<void>);
    } catch (value) {
      reject(value);
      throw value;
    }
    return close;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let yes!: () => void, no!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    stopped = true;
    privateProjection?.beginClose();
    epoch++;
    active = undefined;
    const enter = () => {
      const entered: Promise<unknown>[] = [];
      for (const duty of duties) {
        try {
          entered.push(duty());
        } catch (value) {
          fail(value);
        }
      }
      return entered;
    };
    const initial = enter();
    if (work) initial.push(work);
    initial.push(...jobs);
    void (async () => {
      let batch = initial;
      do {
        for (const result of await Promise.allSettled(batch))
          if (result.status === 'rejected' && !expected(result.reason)) fail(result.reason);
        batch = [...jobs, ...enter()];
      } while (batch.length || duties.size);
      if (privateProjection) {
        try {
          await privateProjection.close();
        } catch (value) {
          fail(value);
        }
      }
      if (failure) no(failure.value);
      else yes();
    })();
    return closing;
  };
  type Mode = ReturnType<
    (typeof import('./startup-mode.js'))['createProductionBrowserStartupMode']
  >;
  type Routes = ReturnType<
    (typeof import('./runtime-routes.js'))['createProductionBrowserRuntimeRoutes']
  >;
  type Graph = {
    mode: Mode;
    router: Routes['router'];
    closeMode: () => Promise<void>;
    prepareDisable: () => Promise<void>;
    closeRoutes: () => Promise<void>;
    enable: Mode['setEnabled'];
    status: Mode['status'];
    toolsAvailable: Mode['runtimeToolsAvailable'];
    optionalToolsAvailable: Mode['runtimeOptionalToolsAvailable'];
    resolveTools: Mode['resolveRuntimeTools'];
    openTools: Mode['openForRuntime'];
    openDelegatedTools: Mode['openDelegatedForRuntime'];
    describeDelegation: Mode['describeRuntimeDelegation'];
    describeFileApproval: Mode['describeRuntimeFileApproval'];
    issueFileApproval: Mode['issueRuntimeFileApproval'];
    closeTools: Mode['closeForRuntime'];
  };
  let active: Graph | undefined, opening: Promise<BrowserProductionStatus> | undefined;
  const graphs = new Set<Graph>();
  let acquire: ReturnType<typeof createProductionBrowserServerInventory>['acquire'] | undefined;
  return Object.freeze({
    close,
    /** Private common-registry receiver. Agent authority is freshly resolved by the original issuer. */
    capabilities(
      principals: RuntimePrincipalService,
      authors: AuthorRegistry
    ): ManagedBrowserCapabilityDeps {
      const capabilities: ManagedBrowserCapabilityDeps = {
        describeFileApproval(input) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const description = graph.describeFileApproval(input);
          guard();
          if (active !== graph) throw refuse();
          return description;
        },
        async issueFileApproval(context, input) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const grant = await graph.issueFileApproval(context, input);
          guard();
          if (active !== graph || context.signal?.aborted || !graph.toolsAvailable())
            throw refuse();
          return Object.freeze({
            grantId: grant.grantId,
            revision: grant.grantRevision,
          });
        },
        describeDelegation(input) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const result = graph.describeDelegation(input);
          guard();
          if (active !== graph) throw refuse();
          return result;
        },
        async openDelegated(context, input) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const result = await graph.openDelegatedTools(principals, authors, context, input);
          guard();
          if (active !== graph || context.signal?.aborted || !graph.toolsAvailable())
            throw refuse();
          return result;
        },
        async close(context, binding) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const result = await graph.closeTools(principals, authors, context, binding);
          guard();
          if (active !== graph || context.signal?.aborted) throw refuse();
          return result;
        },
        async open(context, request, initialUrl) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const result = await graph.openTools(principals, authors, context, request, initialUrl);
          const available = graph.toolsAvailable();
          guard();
          if (!available || active !== graph || context.signal?.aborted) throw refuse();
          return result;
        },
        optionalAvailable() {
          if (stopped || failure || !active) return false;
          const graph = active;
          const available = graph.optionalToolsAvailable();
          return available && !stopped && !failure && active === graph;
        },
        current() {
          if (stopped || failure || !active) return false;
          const graph = active;
          const available = graph.toolsAvailable();
          return available && !stopped && !failure && active === graph;
        },
        resolve(binding) {
          guard();
          const graph = active;
          if (!graph) throw refuse();
          const tools = graph.resolveTools(binding, principals, authors);
          guard();
          if (active !== graph) throw refuse();
          return tools;
        },
      };
      return Object.freeze(capabilities);
    },
    start(options: {
      installationId?: string;
      app: Express;
      db: Db;
      config: ConfigManager;
      auth: () => Auth | undefined;
    }): Promise<void> {
      if (stopped || work) return Promise.reject(failure ? failure.value : refuse());
      let yes!: () => void, no!: (value: unknown) => void;
      work = new Promise<void>((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      void work.catch((value) => {
        if (!expected(value)) fail(value);
        void close().catch(() => {});
      });
      try {
        const config = options.config,
          db = options.db,
          app = options.app,
          getAuth = options.auth,
          installationId = options.installationId;
        const get = config.get.bind(config),
          set = config.setDot.bind(config),
          mount = app.use.bind(app),
          subscribe = config.onChange.bind(config);
        guard();
        const inventory = createProductionBrowserServerInventory();
        bankClose(inventory);
        guard();
        acquire = inventory.acquire.bind(inventory);
        guard();
        const authenticate = createActivationAuthentication(
          db,
          config,
          getAuth,
          () => !stopped && !failure
        );
        const closeGraphs = async () => {
          const originals: Promise<unknown>[] = [];
          const captured = [...graphs];
          for (const graph of captured)
            for (const duty of [graph.closeRoutes, graph.closeMode]) {
              try {
                originals.push(duty());
              } catch (value) {
                fail(value);
              }
            }
          for (const result of await Promise.allSettled(originals))
            if (result.status === 'rejected') fail(result.reason);
          for (const graph of captured) graphs.delete(graph);
          if (failure) throw failure.value;
        };
        const transitions = new Set<Promise<BrowserProductionStatus>>();
        let identityChanging = false;
        const chooseIdentity = config.chooseOwnedBrowserIdentity.bind(config);
        const enabled = (
          chosen: boolean,
          cookie: string | undefined,
          signal: AbortSignal,
          chromeUserAgent?: boolean
        ): Promise<BrowserProductionStatus> => {
          const selectingIdentity = chromeUserAgent !== undefined;
          if (
            identityChanging ||
            (selectingIdentity &&
              (chosen ||
                transitions.size ||
                opening ||
                active ||
                graphs.size ||
                get('browser').enabled))
          )
            return Promise.reject(refuse());
          if (selectingIdentity) identityChanging = true;
          if (chosen && opening) return Promise.reject(refuse());
          let yes!: (value: BrowserProductionStatus) => void, no!: (value: unknown) => void;
          const original = retain(
            new Promise<BrowserProductionStatus>((resolve, reject) => {
              yes = resolve;
              no = reject;
            })
          );
          transitions.add(original);
          void original.then(
            () => {
              transitions.delete(original);
              if (selectingIdentity) identityChanging = false;
            },
            () => {
              transitions.delete(original);
              if (selectingIdentity) identityChanging = false;
            }
          );
          if (chosen) opening = original;
          void Promise.resolve()
            .then(async () => {
              guard();
              const actor = await observeOriginalStartupPhase('startup.authenticate', () => {
                guard();
                return authenticate(cookie, signal);
              });
              guard();
              if (selectingIdentity) {
                const selected = chromeUserAgent!;
                const admittedEpoch = epoch;
                const admitIdentity = () => {
                  guard();
                  return (
                    identityChanging &&
                    transitions.size === 1 &&
                    transitions.has(original) &&
                    !opening &&
                    !active &&
                    graphs.size === 0 &&
                    !get('browser').enabled &&
                    epoch === admittedEpoch &&
                    !signal.aborted &&
                    actor()
                  );
                };
                if (!admitIdentity()) throw refuse();
                chooseIdentity(
                  selected,
                  mintBrowserIdentityChoicePermit(config, selected, admitIdentity)
                );
                if (!admitIdentity() || get('browser').chromeUserAgent !== selected) throw refuse();
                return BrowserProductionStatusSchema.parse({ state: 'disabled', enabled: false });
              }
              if (!chosen) {
                // Fence ordinary graph admission immediately. Keep native authority until
                // the captured original input-loss preparation joins; then persist Off.
                epoch++;
                active = undefined;
                const preparations: Promise<unknown>[] = [];
                for (const graph of graphs) {
                  try {
                    const work = graph.prepareDisable();
                    void work.catch(fail);
                    preparations.push(work);
                  } catch (value) {
                    fail(value);
                  }
                }
                for (const result of await Promise.allSettled(preparations))
                  if (result.status === 'rejected') fail(result.reason);
                // A partial or failed original store write cannot suppress independent teardown.
                try {
                  set('browser.enabled', false);
                } catch (value) {
                  fail(value);
                }
                const stop = closeGraphs(); // Enter independent originals before waiting on held enable.
                const currentOpening = opening;
                const results = await Promise.allSettled([
                  stop,
                  ...(currentOpening ? [currentOpening] : []),
                ]);
                for (const result of results)
                  if (result.status === 'rejected' && !expected(result.reason)) fail(result.reason);
                if (failure) throw failure.value;
                if (!actor() || stopped || get('browser').enabled) throw refuse();
                return BrowserProductionStatusSchema.parse({
                  state: 'disabled',
                  enabled: false,
                });
              }
              if (active && get('browser').enabled) return active.status({ cookie }, signal);
              const admittedEpoch = ++epoch;
              const admit = () => {
                guard();
                if (epoch !== admittedEpoch || !actor() || signal.aborted) throw refuse();
              };
              admit();
              const modeModule = await observeOriginalStartupPhase('startup.import-mode', () => {
                admit();
                return import('./startup-mode.js');
              });
              admit();
              const routeModule = await observeOriginalStartupPhase('startup.import-routes', () => {
                admit();
                return import('./runtime-routes.js');
              });
              admit();
              const createMode = modeModule.createProductionBrowserStartupMode.bind(modeModule),
                createRoutes = routeModule.createProductionBrowserRuntimeRoutes.bind(routeModule),
                originalExpected = modeModule.isOriginalStartupRefusal.bind(modeModule);
              known.add(originalExpected);
              const auth = getAuth();
              if (!auth) throw refuse();
              admit();
              const mode = createMode({
                db,
                auth,
                config,
                inventory,
                installationId,
                ...(measuredResources ? { measuredResources } : {}),
                ...(privateObservers
                  ? {
                      resourceAcceptance: privateObservers.resources,
                      viewerSamples: privateObservers.viewerSamples,
                    }
                  : {}),
              });
              const closeMode = bankClose(mode);
              try {
                privateBrowserAcceptance?.captureMode(mode);
                admit();
              } catch (value) {
                await closeMode();
                throw value;
              }
              const enable = mode.setEnabled.bind(mode),
                status = mode.status.bind(mode);
              const routes = createRoutes(mode),
                closeRoutes = bankClose(routes);
              try {
                admit();
              } catch (value) {
                await Promise.allSettled([closeRoutes(), closeMode()]);
                throw value;
              }
              const graph: Graph = {
                mode,
                router: routes.router,
                closeMode,
                prepareDisable: mode.prepareDisable.bind(mode),
                closeRoutes,
                enable,
                status,
                toolsAvailable: mode.runtimeToolsAvailable.bind(mode),
                optionalToolsAvailable: mode.runtimeOptionalToolsAvailable.bind(mode),
                resolveTools: mode.resolveRuntimeTools.bind(mode),
                openTools: mode.openForRuntime.bind(mode),
                openDelegatedTools: mode.openDelegatedForRuntime.bind(mode),
                describeDelegation: mode.describeRuntimeDelegation.bind(mode),
                describeFileApproval: mode.describeRuntimeFileApproval.bind(mode),
                issueFileApproval: mode.issueRuntimeFileApproval.bind(mode),
                closeTools: mode.closeForRuntime.bind(mode),
              };
              graphs.add(graph);
              admit();
              let result: BrowserProductionStatus;
              try {
                result = await enable(true, { cookie }, signal);
                admit();
              } catch (value) {
                if (!expected(value)) fail(value);
                active = undefined;
                // Fence even an opt-in that failed after writing; independently join both originals.
                try {
                  set('browser.enabled', false);
                } catch (secondary) {
                  fail(secondary);
                }
                const results = await Promise.allSettled([closeRoutes(), closeMode()]);
                for (const result of results) if (result.status === 'rejected') fail(result.reason);
                graphs.delete(graph);
                throw value;
              }
              if (result.state !== 'ready' || !get('browser').enabled || !mode.modeCurrent())
                throw refuse();
              admit();
              active = graph;
              return result;
            })
            .then(yes, no);
          if (chosen)
            void original.then(
              () => {
                if (opening === original) opening = undefined;
              },
              () => {
                if (opening === original) opening = undefined;
              }
            );
          return original;
        };
        const status = async (
          cookie: string | undefined,
          signal: AbortSignal
        ): Promise<BrowserProductionStatus> => {
          const actor = await authenticate(cookie, signal);
          guard();
          if (!actor()) throw refuse();
          if (!get('browser').enabled)
            return BrowserProductionStatusSchema.parse({
              state: 'disabled',
              enabled: false,
            });
          if (!active)
            return BrowserProductionStatusSchema.parse({
              state: 'unavailable',
              enabled: true,
              cause: 'nativeUnavailable',
            });
          return active.status({ cookie }, signal);
        };
        const facade = createBrowserActivationRoutes({
          authenticate,
          enable: enabled,
          status,
          expected,
        });
        bankClose(facade);
        guard();
        const router = Router();
        router.use(facade.router);
        router.use((req, res, next) => {
          const graph = active;
          if (!graph || stopped || failure || !get('browser').enabled || !graph.mode.modeCurrent())
            return next();
          graph.router(req, res, next);
        });
        let yesUnsubscribe!: (original: () => void) => void,
          noUnsubscribe!: (value: unknown) => void;
        const subscriptionReady = new Promise<() => void>((yes, no) => {
          yesUnsubscribe = yes;
          noUnsubscribe = no;
        });
        void subscriptionReady.catch(() => {});
        bankClose({
          close: () => subscriptionReady.then((original) => original()),
        });
        try {
          const unsubscribe = subscribe((change) => {
            if (
              change.paths.some((path) => path === 'browser.enabled' || path === 'browser') &&
              !get('browser').enabled
            ) {
              epoch++;
              active = undefined;
              void closeGraphs().catch(fail);
            }
          });
          if (typeof unsubscribe !== 'function') throw refuse();
          yesUnsubscribe(unsubscribe);
        } catch (value) {
          noUnsubscribe(value);
          throw value;
        }
        mount('/api/browser', router);
        guard();
        // A saved true bit still has no native authority; only a fresh authenticated enable births it.
        yes();
      } catch (value) {
        if (!expected(value)) fail(value);
        no(value);
      }
      return work;
    },
    listen(
      _fallback: () => Server,
      create: () => Server,
      bind: (original: Server) => void
    ): Server {
      guard();
      if (!acquire) throw refuse();
      return acquire('dorkos', 'main', create, bind);
    },
  });
}
