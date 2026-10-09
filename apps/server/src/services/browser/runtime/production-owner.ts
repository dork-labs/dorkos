import { resolveDorkHome } from '../../../lib/dork-home.js';
import { BrowserRegistryStore } from '../registry/store.js';
import { constructOriginalManagedVMEngine } from '../vm/engine.mjs';
import { openOriginalInstalledPrebuiltRelease } from './prebuilt-release.mjs';
import {
  issueOriginalVMRuntimeSubject,
  inspectOriginalVMRuntimeSubject,
} from './runtime-subject.mjs';
import type { EngineConfiguration, BrowserRuntimeDescriptor } from '@dorkos/browser';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserBirthOwner,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';

/** Refuses runtime work when the installed browser cannot be admitted safely. */
export class ProductionRuntimeRefusal extends Error {
  constructor(
    readonly code:
      'CLOSED' | 'BUSY' | 'UNSUPPORTED' | 'VERIFICATION_UNAVAILABLE' | 'CUSTODY_UNCERTAIN'
  ) {
    super(code);
    this.name = 'ProductionRuntimeRefusal';
  }
}
/** Fixed installed VM selection. No runtime path, generic executable, private
 * developer sign token or prior-process JSON capability enters this owner. */
export function createProductionBrowserRuntimeOwner() {
  let closed = false,
    first: Readonly<{ value: unknown }> | undefined;
  let originalOpen:
    | Promise<
        Readonly<{
          engine: BrowserLifecycleEngine;
          opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
        }>
      >
    | undefined;
  let engine: BrowserLifecycleEngine | undefined,
    release: unknown,
    shutdown: ReturnType<BrowserLifecycleEngine['shutdown']> | undefined,
    closing: Promise<void> | undefined;
  let birth:
    | Readonly<{
        receiver: PrivateBrowserRetirementReceiver;
        ordinary: () => boolean;
        current: () => boolean;
        binding: PrivateBrowserRetirementReceiver['verifiedRuntimeBinding'];
      }>
    | undefined;
  let removeLoss: (() => void) | undefined;
  let expected: Readonly<{ runtimeIdentity: string; policyRevision: number }> | undefined,
    opened = false,
    refusedBirth = false;
  const abort = new AbortController();
  const fail = (value: unknown) => {
    first ??= Object.freeze({ value });
  };
  const check = () => {
    if (first) throw first.value;
    if (closed || abort.signal.aborted) throw new ProductionRuntimeRefusal('CLOSED');
  };
  const enterShutdown = () => {
    if (engine && !shutdown)
      try {
        shutdown = engine.shutdown();
      } catch (value) {
        fail(value);
      }
  };
  const close = () => {
    if (closing) return closing;
    let yes!: () => void, no!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    closed = true;
    opened = false;
    try {
      abort.abort(first?.value);
    } catch (value) {
      fail(value);
    }
    try {
      removeLoss?.();
    } catch (value) {
      fail(value);
    }
    enterShutdown();
    void (async () => {
      if (originalOpen)
        for (const row of await Promise.allSettled([originalOpen]))
          if (row.status === 'rejected') fail(row.reason);
      enterShutdown();
      if (shutdown) {
        const [row] = await Promise.allSettled([shutdown]);
        if (row.status === 'rejected') fail(row.reason);
        else if (row.value.some((value) => value.cleanup !== 'observed'))
          fail(new ProductionRuntimeRefusal('CUSTODY_UNCERTAIN'));
      }
      // Keep the actual release capability and uncertain records retained; an
      // original VM return is not a guest filesystem/profile durability grant.
      void release;
      if (first) throw first.value;
    })().then(yes, (value) => {
      fail(value);
      no(first!.value);
    });
    return closing;
  };
  const nativeCurrent = (receiver: PrivateBrowserRetirementReceiver) => {
    if (closed || first || !birth || birth.receiver !== receiver || refusedBirth || !expected)
      return false;
    try {
      if (!birth.ordinary() || !birth.current()) return false;
      const value = birth.binding();
      return (
        !closed &&
        !first &&
        !refusedBirth &&
        value?.runtimeIdentity === expected.runtimeIdentity &&
        value.policyRevision === expected.policyRevision &&
        birth.current()
      );
    } catch (value) {
      fail(value);
      void close().catch(() => {});
      return false;
    }
  };
  return Object.freeze({
    close,
    open(
      configuration: Omit<EngineConfiguration, 'runtime'>,
      participant: PrivateBrowserBirthOwner & { bindEngine(engine: BrowserLifecycleEngine): void },
      command: unknown,
      signal: AbortSignal | undefined,
      identityMode: BrowserRuntimeDescriptor['identity']['mode'] = 'native',
      initialStorageState?: unknown,
      selection?: Readonly<{ registry: BrowserRegistryStore; ownerId: string }>
    ) {
      if (closed)
        return Promise.reject(first ? first.value : new ProductionRuntimeRefusal('CLOSED'));
      if (originalOpen) return Promise.reject(new ProductionRuntimeRefusal('BUSY'));
      let yes!: (
          value: Readonly<{
            engine: BrowserLifecycleEngine;
            opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
          }>
        ) => void,
        no!: (value: unknown) => void;
      originalOpen = new Promise((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      void originalOpen.catch((value) => {
        fail(value);
        void close().catch(() => {});
      });
      // Whole original admission is registered before fallible participant reads.
      void Promise.resolve()
        .then(async () => {
          check();
          if (
            !(selection?.registry instanceof BrowserRegistryStore) ||
            typeof selection.ownerId !== 'string' ||
            !selection.ownerId ||
            initialStorageState !== undefined ||
            !['native', 'chrome-compatible'].includes(identityMode)
          )
            throw new ProductionRuntimeRefusal('UNSUPPORTED');
          const registry = selection.registry,
            ownerId = selection.ownerId;
          const input = participant.input,
            capture = participant.capture,
            navigation = participant.navigation,
            network = participant.network;
          if (
            !input ||
            !capture ||
            !navigation ||
            !network ||
            configuration.network.kind !== 'owned'
          )
            throw new ProductionRuntimeRefusal('UNSUPPORTED');
          const bindEngine = participant.bindEngine.bind(participant),
            register = participant.registerBirth.bind(participant),
            refuse = participant.refuseBirth.bind(participant);
          const dataHome = resolveDorkHome(),
            revision = configuration.network.policyRevision;
          const policy = Object.freeze({
            authorizeAction: configuration.policy.authorizeAction.bind(configuration.policy),
            verifyBrokerLease: configuration.policy.verifyBrokerLease.bind(configuration.policy),
          });
          const owned: PrivateBrowserBirthOwner = Object.freeze({
            input: Object.freeze({ registerDispatcher: input.registerDispatcher.bind(input) }),
            capture: Object.freeze({
              registerDispatcher: capture.registerDispatcher.bind(capture),
            }),
            navigation: Object.freeze({
              registerDispatcher: navigation.registerDispatcher.bind(navigation),
            }),
            ...(participant.upload
              ? {
                  upload: Object.freeze({
                    registerDispatcher: participant.upload.registerDispatcher.bind(
                      participant.upload
                    ),
                  }),
                }
              : {}),
            ...(participant.download
              ? {
                  download: Object.freeze({
                    registerDispatcher: participant.download.registerDispatcher.bind(
                      participant.download
                    ),
                  }),
                }
              : {}),
            ...(participant.semantic
              ? {
                  semantic: Object.freeze({
                    registerDispatcher: participant.semantic.registerDispatcher.bind(
                      participant.semantic
                    ),
                  }),
                }
              : {}),
            network: Object.freeze({
              bindBeforeLaunch: network.bindBeforeLaunch.bind(network),
              activateReady: network.activateReady.bind(network),
            }),
            registerBirth(receiver: PrivateBrowserRetirementReceiver) {
              check();
              if (birth) throw new ProductionRuntimeRefusal('BUSY');
              birth = Object.freeze({
                receiver,
                ordinary: receiver.isOrdinary.bind(receiver),
                current: receiver.isAuthorityCurrent.bind(receiver),
                binding: receiver.verifiedRuntimeBinding.bind(receiver),
              });
              register(receiver);
              check();
              if (!birth.ordinary()) throw new ProductionRuntimeRefusal('CLOSED');
            },
            refuseBirth(receiver: PrivateBrowserRetirementReceiver) {
              if (birth?.receiver === receiver) refusedBirth = true;
              refuse(receiver);
            },
          });
          {
            if (signal) {
              const lost = () => {
                fail(signal.reason);
                void close().catch(() => {});
              };
              signal.addEventListener('abort', lost, { once: true });
              removeLoss = () => signal.removeEventListener('abort', lost);
              if (signal.aborted) lost();
            }
            check();
            release = await openOriginalInstalledPrebuiltRelease({
              dataHome,
              current: () => !closed && !first && !abort.signal.aborted,
            });
            check();
            const subject = await issueOriginalVMRuntimeSubject(release, revision);
            check();
            expected = inspectOriginalVMRuntimeSubject(subject, release).binding;
            engine = constructOriginalManagedVMEngine({
              registry,
              owner: ownerId,
              dataHome,
              release,
              width: 1280,
              height: 800,
              birthOwner: owned,
              policy,
              policyRevision: revision,
            });
            check();
            bindEngine(engine);
            check();
            const result = await engine.open(command);
            check();
            opened = true;
            return Object.freeze({ engine, opened: result });
          }
        })
        .then(yes, no);
      return originalOpen;
    },
    isOriginalNativeCurrent: nativeCurrent,
    isNativeCurrent(candidate: BrowserLifecycleEngine) {
      return opened && candidate === engine && !!birth && nativeCurrent(birth.receiver);
    },
  });
}
