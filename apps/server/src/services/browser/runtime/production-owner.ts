import { logger } from '../../../lib/logger.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  parseRuntimeDescriptor,
  type EngineConfiguration,
  type BrowserRuntimeDescriptor,
} from '@dorkos/browser';
import {
  constructOwnedBrowserEngine,
  type BrowserLifecycleEngine,
  type AuthorityCustodyRefusalStage,
  type RetirementCloseRefusalStage,
  type PrivateBrowserBirthOwner,
  type PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import { resolveServerBrowserRuntimePackage } from './installed-package.js';

/** Closed private diagnostics; no arbitrary producer text reaches product status. */
export class ProductionRuntimeRefusal extends Error {
  constructor(
    readonly code:
      'CLOSED' | 'BUSY' | 'UNSUPPORTED' | 'VERIFICATION_UNAVAILABLE' | 'CUSTODY_UNCERTAIN'
  ) {
    super(code);
    this.name = 'ProductionRuntimeRefusal';
  }
}

interface Birth {
  readonly receiver: PrivateBrowserRetirementReceiver;
  readonly ordinary: () => boolean;
  readonly current: () => boolean;
  readonly refusal?: () => AuthorityCustodyRefusalStage | undefined;
  readonly closeDiagnostic: {
    read?: () => RetirementCloseRefusalStage | undefined;
  };
  readonly runtime: PrivateBrowserRetirementReceiver['verifiedRuntimeBinding'];
  refused: boolean;
}

/** One production acquisition owner. Construction supplies neither actor authority nor opt-in.
 * The startup host must retain this owner, supply its genuine authenticated birth/network/input/
 * capture participants, and join close before releasing them. No fixture or repair fallback exists. */
export function createProductionBrowserRuntimeOwner() {
  let diagnosticCount = 0;
  let emit: typeof logger.info | undefined;
  try {
    emit = logger.info.bind(logger);
  } catch {
    /* Diagnostics never confer authority. */
  }
  const noteCustodyRefusal = () => {
    if (diagnosticCount >= 16) return;
    try {
      const stage = birth?.refusal?.();
      if (
        ![
          'local',
          'membership',
          'network',
          'journal',
          'supervisor',
          'slot',
          'transport',
          'reentrant',
          'popup',
          'exception',
        ].some((literal) => stage === literal)
      )
        return;
      emit?.(
        'Browser original custody refusal stage',
        Object.freeze({ stage, ordinal: ++diagnosticCount })
      );
    } catch {
      /* Preserve the actual custody result and original operational cause. */
    }
  };
  const readCloseRefusal = () => {
    try {
      const original = birth?.closeDiagnostic.read;
      if (!original) return 'unavailable';
      const stage = original();
      if (stage === undefined) return 'none';
      return [
        'entry',
        'aggregate',
        'terminal',
        'setup',
        'snapshot',
        'navigation',
        'context',
        'inputs',
        'proxy',
        'connection',
        'network',
        'journal',
        'observe-gone',
        'final-custody',
        'directory',
        'release',
      ].some((code) => code === stage)
        ? stage
        : 'invalid';
    } catch {
      return 'unavailable'; // A diagnostic method cannot replace original sealed data or close.
    }
  };
  const originalPromiseThen = Promise.prototype.then;
  const noteRetirement = (
    observation: Awaited<PrivateBrowserRetirementReceiver['observation']>
  ) => {
    // Existing sealed producer data only. No identities, bindings, participant errors or queries.
    const literal = (value: unknown, allowed: readonly string[]) =>
      allowed.some((code) => code === value) ? value : 'invalid';
    const reasons = [
      'permitUnavailable',
      'targetChanged',
      'clockUnavailable',
      'drainTimeout',
      'releaseTimeout',
      'custodyPending',
      'observationUnavailable',
      'drainFailed',
      'releaseFailed',
    ];
    try {
      const cleanup = observation.cleanup;
      const owners = observation.owners;
      const ownerCount =
        Number.isSafeInteger(owners.length) && owners.length >= 0 && owners.length <= 512
          ? owners.length
          : 'invalid';
      let firstOwner: (typeof owners)[number]['observation'] | undefined;
      if (ownerCount !== 'invalid') {
        for (const owner of owners) {
          if (owner.observation.state !== 'settled') {
            firstOwner = owner.observation;
            break;
          }
        }
      }
      const terminal = observation.terminal;
      emit?.(
        'Browser original sealed retirement result',
        Object.freeze({
          ordinal: 1,
          closeStage:
            terminal.cleanup === 'failed' || terminal.cleanup === 'unverified'
              ? readCloseRefusal()
              : 'none',
          aggregateState: literal(cleanup.state, ['settled', 'failed', 'unverified']),
          coverage: literal(cleanup.coverage, ['closed', 'unavailable']),
          pending: typeof cleanup.pending === 'boolean' ? cleanup.pending : 'invalid',
          aggregateReasons: Object.freeze(
            cleanup.uncertainty.slice(0, 16).map((value) => literal(value, reasons))
          ),
          ownerCount,
          firstOwnerState: firstOwner
            ? literal(firstOwner.state, ['failed', 'unverified'])
            : ownerCount === 'invalid'
              ? 'unobserved'
              : 'none',
          firstOwnerReason:
            firstOwner && 'reason' in firstOwner ? literal(firstOwner.reason, reasons) : 'none',
          firstOwnerPending: firstOwner
            ? typeof firstOwner.pending === 'boolean'
              ? firstOwner.pending
              : 'invalid'
            : false,
          terminalCleanup: literal(terminal.cleanup, [
            'observed',
            'failed',
            'unverified',
            'notYetObserved',
          ]),
          terminalReason:
            'reason' in terminal
              ? literal(terminal.reason, [
                  'processesRemain',
                  'observationUnavailable',
                  'closeFailed',
                ])
              : 'none',
          firstCause: literal(observation.firstCause, [
            'explicitStop',
            'disabled',
            'authorityRevoked',
            'persistenceFailure',
            'engineFault',
            'cleanupFailure',
          ]),
        })
      );
    } catch {
      /* A diagnostic callback cannot replace any original retirement or close outcome. */
    }
  };
  const observeOriginalRetirement = (receiver: PrivateBrowserRetirementReceiver) => {
    try {
      const original = receiver.observation; // Capture exactly once, after genuine register/check.
      // Observe the genuine Promise without reading a participant-supplied then method or adding a wait.
      void originalPromiseThen.call(original, noteRetirement, () => {});
    } catch {
      /* Diagnostic registration is isolated from original birth/authority/cleanup. */
    }
  };
  const abort = new AbortController();
  const stopVerification = abort.abort.bind(abort);
  let closed = false;
  let failed = false;
  let failure: unknown;
  const fail = (reason: unknown) => {
    if (!failed) {
      failed = true;
      failure = reason;
    }
  };
  // Retain package/installation facade, actual open and shutdown receivers through all uncertainty.
  let packaged: Awaited<ReturnType<typeof resolveServerBrowserRuntimePackage>> | undefined;
  let work:
    | Promise<
        Readonly<{
          engine: BrowserLifecycleEngine;
          opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
        }>
      >
    | undefined;
  let engine: BrowserLifecycleEngine | undefined;
  let shutdown: BrowserLifecycleEngine['shutdown'] | undefined;
  let shutdownWork: ReturnType<BrowserLifecycleEngine['shutdown']> | undefined;
  let birth: Birth | undefined;
  let expected: Readonly<{ runtimeIdentity: string; policyRevision: number }> | undefined;
  let opened = false;
  let closeWork: Promise<void> | undefined;
  let removeLoss: (() => void) | undefined;
  const check = () => {
    if (closed || abort.signal.aborted)
      throw failed ? failure : new ProductionRuntimeRefusal('CLOSED');
  };
  const enterShutdown = () => {
    if (shutdown && !shutdownWork) {
      try {
        shutdownWork = Reflect.apply(shutdown, engine, []);
      } catch (error) {
        fail(error);
      }
    }
  };
  const close = (): Promise<void> => {
    if (closeWork) return closeWork;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    closeWork = new Promise<void>((done, refused) => {
      resolve = done;
      reject = refused;
    });
    closed = true;
    opened = false;
    try {
      stopVerification(failed ? failure : new ProductionRuntimeRefusal('CLOSED'));
    } catch (error) {
      fail(error);
    }
    try {
      removeLoss?.();
    } catch (error) {
      fail(error);
    }
    enterShutdown(); // Original shutdown synchronously fences all existing records before joins.
    void (async () => {
      if (work) {
        try {
          await work;
        } catch (error) {
          fail(error);
        }
      }
      enterShutdown();
      if (shutdownWork) {
        try {
          const outcomes = await shutdownWork;
          const diagnostic: {
            refused?: { outcome: (typeof outcomes)[number]; cleanup: unknown };
          } = {};
          if (
            outcomes.some((outcome) => {
              const cleanup = outcome.cleanup; // Same original one-read classification order.
              if (cleanup === 'observed') return false;
              diagnostic.refused = { outcome, cleanup };
              return true;
            })
          ) {
            fail(new ProductionRuntimeRefusal('CUSTODY_UNCERTAIN'));
            // Classification and first failure are sealed before this non-authoritative sink.
            // Read only a data descriptor: participant getters and arbitrary error text never enter.
            try {
              const cleanup =
                diagnostic.refused!.cleanup === 'failed' ||
                diagnostic.refused!.cleanup === 'unverified'
                  ? diagnostic.refused!.cleanup
                  : 'invalid';
              const descriptor = Object.getOwnPropertyDescriptor(
                diagnostic.refused!.outcome,
                'reason'
              );
              const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
              const reason =
                value === 'processesRemain' ||
                value === 'observationUnavailable' ||
                value === 'closeFailed'
                  ? value
                  : descriptor
                    ? 'invalid'
                    : 'missing';
              emit?.(
                'Browser original shutdown refused result',
                Object.freeze({ cleanup, reason, ordinal: 1 })
              );
            } catch {
              /* Original cleanup result and exact first failure remain unchanged. */
            }
          }
        } catch (error) {
          fail(error);
        }
      }
      // The actual installation facade remains retained even when an uncertain DTO has returned.
      void packaged;
      if (failed) reject(failure);
      else resolve();
    })().catch((error) => {
      fail(error);
      reject(failure);
    });
    return closeWork;
  };
  return Object.freeze({
    /** Fresh existing-only verification precedes exactly one original native-owned browser birth.
     * Caller configuration supplies real clocks, native journal and authenticated ordinary policy.
     * Runtime paths/hashes are replaced from the actual verified package, never accepted from wire. */
    open(
      configuration: Omit<EngineConfiguration, 'runtime'>,
      participant: PrivateBrowserBirthOwner & {
        bindEngine(engine: BrowserLifecycleEngine): void;
      },
      command: unknown,
      signal?: AbortSignal,
      identityMode: BrowserRuntimeDescriptor['identity']['mode'] = 'native'
    ) {
      if (closed) return Promise.reject(failed ? failure : new ProductionRuntimeRefusal('CLOSED'));
      if (work) return Promise.reject(new ProductionRuntimeRefusal('BUSY'));
      let resolveOpen!: (
        value: Readonly<{
          engine: BrowserLifecycleEngine;
          opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
        }>
      ) => void;
      let rejectOpen!: (reason: unknown) => void;
      // Register the whole admission before any captured participant getter can reenter close.
      work = new Promise((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });
      void work.catch((reason) => {
        fail(reason);
        void close().catch(() => {});
      });
      try {
        // Capture constructor participants once, before any asynchronous package producer.
        const input = participant.input;
        const capture = participant.capture;
        const navigation = participant.navigation;
        const upload = participant.upload;
        const download = participant.download;
        const semantic = participant.semantic;
        const uploadRegister = upload?.registerDispatcher;
        const downloadRegister = download?.registerDispatcher;
        const semanticRegister = semantic?.registerDispatcher;
        if (
          (upload && typeof uploadRegister !== 'function') ||
          (download && typeof downloadRegister !== 'function') ||
          (semantic && typeof semanticRegister !== 'function')
        )
          throw new ProductionRuntimeRefusal('UNSUPPORTED');
        const ownedUpload =
          upload && uploadRegister
            ? Object.freeze({ registerDispatcher: uploadRegister.bind(upload) })
            : undefined;
        const ownedDownload =
          download && downloadRegister
            ? Object.freeze({
                registerDispatcher: downloadRegister.bind(download),
              })
            : undefined;
        const ownedSemantic =
          semantic && semanticRegister
            ? Object.freeze({
                registerDispatcher: semanticRegister.bind(semantic),
              })
            : undefined;
        if (identityMode !== 'native' && identityMode !== 'chrome-compatible')
          throw new ProductionRuntimeRefusal('UNSUPPORTED');
        const native = participant.network;
        const network = Object.freeze({ ...configuration.network });
        // Do not enter the verifier for fixture networks or absent genuine native egress ownership.
        if (network.kind !== 'owned' || !native || !input || !capture || !navigation)
          throw new ProductionRuntimeRefusal('UNSUPPORTED');
        const clock = configuration.clock;
        const processes = configuration.processes;
        const policy = configuration.policy;
        const nativeJournal = configuration.nativeJournal;
        const recovery = configuration.recordedRecovery;
        // Optional fields must remain absent: the canonical validator rejects own undefined values.
        const browserWorkerPath = nativeJournal?.browserWorkerPath;
        const continuous = nativeJournal?.continuous;
        const onDiagnostic = nativeJournal?.onDiagnostic;
        const settings = Object.freeze({
          dataDir: configuration.dataDir,
          network,
          clock: Object.freeze({
            wallNow: clock.wallNow.bind(clock),
            monotonicNow: clock.monotonicNow.bind(clock),
          }),
          processes: Object.freeze({
            observe: processes.observe.bind(processes),
            descendants: processes.descendants.bind(processes),
          }),
          policy: Object.freeze({
            authorizeAction: policy.authorizeAction.bind(policy),
            verifyBrokerLease: policy.verifyBrokerLease.bind(policy),
          }),
          ...(nativeJournal
            ? {
                nativeJournal: Object.freeze({
                  workerPath: nativeJournal.workerPath,
                  ...(browserWorkerPath === undefined ? {} : { browserWorkerPath }),
                  artifact: Object.freeze({ ...nativeJournal.artifact }),
                  duration: nativeJournal.duration,
                  ...(continuous === undefined ? {} : { continuous }),
                  maxGap: nativeJournal.maxGap,
                  ...(onDiagnostic === undefined
                    ? {}
                    : { onDiagnostic: onDiagnostic.bind(nativeJournal) }),
                }),
              }
            : {}),
          ...(recovery ? { recordedRecovery: recovery } : {}),
        });
        const registerInput = input.registerDispatcher;
        const registerCapture = capture.registerDispatcher;
        const registerNavigation = navigation.registerDispatcher;
        if (
          typeof registerInput !== 'function' ||
          typeof registerCapture !== 'function' ||
          typeof registerNavigation !== 'function'
        )
          throw new ProductionRuntimeRefusal('UNSUPPORTED');
        const observeLifetime = navigation.observeLifetime;
        const continuation = navigation.continuation;
        const ownedContinuation = continuation
          ? Object.freeze({
              acquire: continuation.acquire.bind(continuation),
              joinPublications: continuation.joinPublications.bind(continuation),
              observeTransition: continuation.observeTransition?.bind(continuation),
            })
          : undefined;
        const ownedNavigation = Object.freeze({
          registerDispatcher: registerNavigation.bind(navigation),
          ...(observeLifetime ? { observeLifetime: observeLifetime.bind(navigation) } : {}),
          ...(ownedContinuation ? { continuation: ownedContinuation } : {}),
        });
        const bindNetwork = native.bindBeforeLaunch;
        const activateNetwork = native.activateReady;
        const ownedInput = Object.freeze({
          registerDispatcher: registerInput.bind(input),
        });
        const ownedCapture = Object.freeze({
          registerDispatcher: registerCapture.bind(capture),
        });
        const ownedNetwork = Object.freeze({
          bindBeforeLaunch: bindNetwork.bind(native),
          activateReady: activateNetwork.bind(native),
        });
        const bindEngine = participant.bindEngine;
        const resourceOriginal = participant.resources;
        const ownedResources = resourceOriginal
          ? Object.freeze({
              onOriginalChild: resourceOriginal.onOriginalChild.bind(resourceOriginal),
            })
          : undefined;
        const register = participant.registerBirth;
        const refuse = participant.refuseBirth;
        const addSignal = signal?.addEventListener;
        const removeSignal = signal?.removeEventListener;
        const production = Promise.resolve().then(async () => {
          check();
          if (signal) {
            const lost = () => {
              fail(signal.reason);
              void close().catch(() => {});
            };
            removeLoss = () => Reflect.apply(removeSignal!, signal, ['abort', lost]);
            check();
            Reflect.apply(addSignal!, signal, ['abort', lost, { once: true }]);
            if (signal.aborted) lost();
            check();
          }
          packaged = await resolveServerBrowserRuntimePackage();
          check();
          const original = packaged.installation;
          const verify = original.verifyExisting;
          const inspect = original.inspectExisting;
          check();
          const verified = await Reflect.apply(verify, original, [{ signal: abort.signal }]);
          check();
          if (
            verified.state !== 'verified-reused' ||
            verified.platform !== 'darwin' ||
            verified.arch !== 'arm64'
          )
            throw new ProductionRuntimeRefusal('VERIFICATION_UNAVAILABLE');
          const current = await Reflect.apply(inspect, original, [{ signal: abort.signal }]);
          check();
          if (
            current.state !== 'installed-files' ||
            current.installationId !== verified.installationId ||
            current.executableSHA256 !== verified.executableSHA256 ||
            current.currentManifestDigest !== verified.currentManifestDigest ||
            current.lastFreshVerifiedVersion !== verified.observedVersion ||
            current.platform !== verified.platform ||
            current.arch !== verified.arch
          )
            throw new ProductionRuntimeRefusal('VERIFICATION_UNAVAILABLE');
          const runtime: BrowserRuntimeDescriptor = parseRuntimeDescriptor({
            library: {
              package: 'playwright-core',
              version: '1.63.0',
              rootDir: packaged.configuration.libraryRoot,
              assets: { manifest: 'browsers.json', cli: 'cli.js' },
            },
            executable: {
              path: join(
                packaged.configuration.cacheRoot,
                'candidates',
                verified.installationId,
                'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
              ),
              sha256: verified.executableSHA256,
              revision: '1243',
              version: verified.observedVersion,
              platform: 'darwin',
              arch: 'arm64',
            },
            identity: {
              mode: identityMode,
              policyRevision: network.policyRevision,
            },
          });
          expected = Object.freeze({
            runtimeIdentity: createHash('sha256').update(JSON.stringify(runtime)).digest('hex'),
            policyRevision: network.policyRevision,
          });
          const owner: PrivateBrowserBirthOwner = Object.freeze({
            input: ownedInput,
            ...(ownedUpload ? { upload: ownedUpload } : {}),
            ...(ownedDownload ? { download: ownedDownload } : {}),
            ...(ownedSemantic ? { semantic: ownedSemantic } : {}),
            ...(ownedResources ? { resources: ownedResources } : {}),
            capture: ownedCapture,
            navigation: ownedNavigation,
            network: ownedNetwork,
            registerBirth(receiver: PrivateBrowserRetirementReceiver) {
              check();
              if (birth) throw new ProductionRuntimeRefusal('BUSY');
              const ordinary = receiver.isOrdinary,
                authority = receiver.isAuthorityCurrent,
                binding = receiver.verifiedRuntimeBinding;
              let refusal: PrivateBrowserRetirementReceiver['authorityCustodyRefusal'];
              try {
                refusal = receiver.authorityCustodyRefusal?.bind(receiver);
              } catch {
                /* Non-authoritative diagnostics. */
              }
              birth = {
                receiver,
                ordinary: ordinary.bind(receiver),
                current: authority.bind(receiver),
                runtime: binding.bind(receiver),
                ...(typeof refusal === 'function' ? { refusal } : {}),
                closeDiagnostic: {},
                refused: false,
              };
              check();
              Reflect.apply(register, participant, [receiver]);
              check();
              const diagnostic = birth.closeDiagnostic;
              try {
                const original = receiver.retirementCloseRefusal;
                if (typeof original === 'function') diagnostic.read = original.bind(receiver);
              } catch {
                /* Only the retained birth owns this non-authoritative diagnostic cell. */
              }
              observeOriginalRetirement(receiver);
            },
            refuseBirth(receiver: PrivateBrowserRetirementReceiver) {
              if (birth?.receiver === receiver) birth.refused = true;
              Reflect.apply(refuse, participant, [receiver]);
            },
          });
          check();
          engine = constructOwnedBrowserEngine({ ...settings, runtime }, owner);
          shutdown = engine.shutdown;
          check();
          Reflect.apply(bindEngine, participant, [engine]);
          check();
          const originalOpen = engine.open;
          check();
          const result = await Reflect.apply(originalOpen, engine, [command]);
          check();
          opened = true;
          return Object.freeze({ engine, opened: result });
        });
        void production.then(resolveOpen, rejectOpen);
        return work;
      } catch (reason) {
        fail(reason);
        rejectOpen(reason);
        return work;
      }
    },
    /** Original registered birth only, including cold native activation before open returns.
     * No caller receiver/copy enters this bank; authority also checks its original SQL/grant/lease. */
    isOriginalNativeCurrent(receiver: PrivateBrowserRetirementReceiver): boolean {
      if (closed || !birth || birth.receiver !== receiver || birth.refused || !expected)
        return false;
      try {
        if (!birth.ordinary() || !birth.current()) {
          noteCustodyRefusal();
          return false;
        }
        const proof = birth.runtime();
        return (
          !closed &&
          !birth.refused &&
          proof?.runtimeIdentity === expected.runtimeIdentity &&
          proof.policyRevision === expected.policyRevision &&
          birth.current() &&
          !closed
        );
      } catch (error) {
        fail(error);
        void close().catch(() => {});
        return false;
      }
    },
    /** Private installation/native custody only; installation readiness stays unavailable.
     * This predicate never activates a public route or grants actor/controller/view permission.
     * Callers must separately check current config/auth/grants and the exact selected binding. */
    isNativeCurrent(candidate: BrowserLifecycleEngine): boolean {
      if (closed || !opened || candidate !== engine || !birth || birth.refused || !expected)
        return false;
      const lost = () => {
        fail(new ProductionRuntimeRefusal('CUSTODY_UNCERTAIN'));
        void close().catch(() => {});
        noteCustodyRefusal();
        return false;
      };
      try {
        if (!birth.ordinary() || !birth.current()) return lost();
        const proof = birth.runtime();
        if (
          !proof ||
          proof.runtimeIdentity !== expected.runtimeIdentity ||
          proof.policyRevision !== expected.policyRevision ||
          !birth.current()
        )
          return lost();
        return !closed && opened && !birth.refused;
      } catch (error) {
        fail(error);
        void close().catch(() => {});
        return false;
      }
    },
    close,
  });
}
