import {
  captureMeasuredBrowserResourceAdmission,
  isMeasuredResourceAdmissionRefusal,
  type MeasuredBrowserResourceAdmission,
} from './admission/measured-resource.js';
import { createOriginalBrowserViewerDiagnostic } from '../stream/viewer-diagnostic.js';
import { selectOriginalBrowserIdentity } from './select-original-browser.js';
import type {
  PrivateBrowserResourceOwner,
  PrivateViewerSampleObserver,
} from './private-native-acceptance.js';
import { createBrowserRuntimeOwnerResolution } from './runtime-owner-resolution.js';
import { importNewBrowserProfile } from './profiles/import.js';
import { joinProductionBrowserClose } from './close-browser-join.js';
import {
  BrowserLocalDestinationRequestSchema,
  BrowserLocalDestinationReceiptSchema,
  type BrowserLocalDestinationRequest,
} from '@dorkos/shared/browser-schemas';
import {
  createRuntimeFileApprovals,
  type RuntimeFileApprovalInput,
} from './runtime-file-approval.js';
import { createBrowserCanvasScopeAdmission } from '../api/canvas-scope-admission.js';
import type { ManagedBrowserCapabilityDeps } from './browser-capabilities.js';
import {
  createRuntimeWorkspaceDelegations,
  type RuntimeWorkspaceDelegation,
} from './runtime-workspace-delegation.js';
import { captureRuntimeBrowserBirth, type RuntimeBrowserBirth } from './runtime-birth.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import { observeOriginalStartupPhase } from './original-phase-diagnostic.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateEngineConfiguration, type EngineConfiguration } from '@dorkos/browser';
import {
  BrowserProductionStatusSchema,
  BrowserProductionProfileImportRequestSchema,
  BrowserProductionProfileImportReceiptSchema,
  type BrowserProductionProfileImportRequest,
  type BrowserStorageState,
  BrowserProductionProfileCreateRequestSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserOpenRequestSchema,
  type BrowserProductionProfileCreateRequest,
  type BrowserOpenRequest,
  type BrowserProductionStatus,
} from '@dorkos/shared/browser-schemas';
import { mintProductionBrowserEnablePermit } from './activation/activation-permit.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { BrowserRegistry } from '../registry/registry.js';
import { BrowserRegistryStore } from '../registry/store.js';
import type { createServerInventory } from '../egress/broker/server-inventory.js';
import {
  createProductionBrowserSession,
  hasProductionBrowserActorFactory,
} from './production-session.js';
import { eq, session, workspaces, type Db } from '@dorkos/db';
import {
  resolveInstalledNativeJournal,
  verifyInstalledNativeJournal,
  type RuntimeInstallationStatus,
  type InstallResult,
} from '@dorkos/browser/runtime-installation';
import { fromNodeHeaders, type Auth } from '../../core/auth/index.js';
import { findOwnerAccount } from '../../core/auth/accounts.js';
import { AuthorRegistry } from '../../rooms/author-registry.js';
import type { ConfigManager } from '../../core/config-manager.js';
import { resolveServerBrowserRuntimePackage } from './installed-package.js';
import { BrokerError } from '../egress/broker/errors.js';

/** Closed actionable mode failures; no native paths or arbitrary producer messages cross HTTP. */
const originalStartupRefusals = new WeakSet<object>();
/** Identify a refusal issued by this original mode, preserving unknown producer failures. */
export function isOriginalStartupRefusal(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && originalStartupRefusals.has(reason);
}
function modeRefusal(code: ConstructorParameters<typeof BrokerError>[0]): BrokerError {
  const reason = new BrokerError(code);
  originalStartupRefusals.add(reason);
  return reason;
}
/** A missing or unsupported installed runtime can be described without exposing native paths. */
export class BrowserStartupRefusal extends Error {
  constructor(readonly cause: 'runtimeMissing' | 'unsupportedPlatform') {
    super(cause);
  }
}
function originalStartupRefusal(cause: BrowserStartupRefusal['cause']): BrowserStartupRefusal {
  const original = new BrowserStartupRefusal(cause);
  originalStartupRefusals.add(original);
  return original;
}
/** Exact startup-created session admission; request bodies cannot mint or select it. */
export interface ProductionBrowserModeAdmission {
  readonly kind: 'production-browser-mode';
}
type Mode = {
  resourceAcceptance?: PrivateBrowserResourceOwner;
  viewerSamples?: PrivateViewerSampleObserver;
  ownerId: string;
  current: () => boolean;
  configuration: EngineConfiguration & {
    network: { kind: 'owned'; origin: 'about:blank'; policyRevision: number };
  };
};
const modes = new WeakMap<ProductionBrowserModeAdmission, Mode>();
/** Constructor-private capture for the genuine production session factory. */
export function captureProductionBrowserMode(
  value: ProductionBrowserModeAdmission
): Readonly<Mode> {
  const original = modes.get(value);
  if (!original || !original.current()) throw modeRefusal('AUTHORITY_REFUSED');
  return original;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Proof = {
  verified: InstallResult;
  native: Awaited<ReturnType<typeof verifyInstalledNativeJournal>>;
  journal: Awaited<ReturnType<typeof resolveInstalledNativeJournal>>;
  configuration: Awaited<ReturnType<typeof resolveServerBrowserRuntimePackage>>['configuration'];
  installation: Awaited<ReturnType<typeof resolveServerBrowserRuntimePackage>>['installation'];
};

/** Startup-owned installation/native-mode admission. This verifies actual installed originals;
 * it confers no workspace grant, Page, controller, view/capture/input or broker forwarding rights.
 * Every actual browser open still needs the separately owned production composition. */
export function createProductionBrowserStartupMode(options: {
  /** Reviewed supported envelope, supplied only by the original startup constructor. */
  measuredResources?: MeasuredBrowserResourceAdmission;
  resourceAcceptance?: PrivateBrowserResourceOwner;
  viewerSamples?: PrivateViewerSampleObserver;
  db: Db;
  auth: Auth;
  config: ConfigManager;
  inventory: ReturnType<typeof createServerInventory>;
  /** Actual canonical boot installation id; never a tool/request owner claim. */
  installationId?: string;
}) {
  const admissionDiagnostic = createOriginalBrowserViewerDiagnostic();
  const requestedResources = options.measuredResources;
  const measuredResources =
    requestedResources === undefined
      ? undefined
      : captureMeasuredBrowserResourceAdmission(requestedResources);
  const resourceCheck = (check: () => void) => {
    try {
      check();
    } catch (value) {
      if (isMeasuredResourceAdmissionRefusal(value)) throw modeRefusal('QUOTA');
      throw value;
    }
  };
  const resourceAcceptance = options.resourceAcceptance,
    viewerSamples = options.viewerSamples;
  const db = options.db,
    auth = options.auth,
    config = options.config,
    inventory = options.inventory;
  // Account credentials and durable browser authors occupy different namespaces.
  // Capture the original owner mapping before asynchronous account/native acquisition.
  const ownerAuthors = new AuthorRegistry(db);
  const bindOwnerAuthor = ownerAuthors.bindOwner.bind(ownerAuthors),
    isOwnerAuthor = ownerAuthors.isOwner.bind(ownerAuthors);
  const authApi = auth.api;
  const getSession = authApi.getSession.bind(authApi);
  const configGet = config.get.bind(config);
  const enableOwnedBrowser = config.enableOwnedBrowser.bind(config);
  const configSetDot = config.setDot.bind(config);
  const subscribeConfig = config.onChange.bind(config);
  const ownAbort = new AbortController();
  const originals = new Set<Promise<unknown>>();
  const browsers = new Set<ReturnType<typeof createProductionBrowserSession>>();
  const store = new BrowserRegistryStore(db, 'production-browser');
  const registry = new BrowserRegistry(store, createBrowserCanvasScopeAdmission(db, ownerAuthors));
  const createProfile = store.createProfile.bind(store),
    readProfiles = store.profiles.bind(store);
  let closed = false,
    epoch = 1;
  let first: Readonly<{ value: unknown }> | undefined;
  let requestsRefused = false;
  let preparing: Promise<Proof> | undefined,
    proof: Proof | undefined,
    closing: Promise<void> | undefined;
  const retain = <T>(original: Promise<T>): Promise<T> => {
    originals.add(original);
    void original.then(
      () => originals.delete(original),
      (reason) => {
        // Known missing/unsupported admission owns no native campaign and is not an unknown cleanup.
        if (!(typeof reason === 'object' && reason !== null && originalStartupRefusals.has(reason)))
          first ??= Object.freeze({ value: reason });
        originals.delete(original);
      }
    );
    return original;
  };
  const authorityCurrent = () =>
    !closed &&
    !ownAbort.signal.aborted &&
    configGet('auth').enabled === true &&
    !closed &&
    !ownAbort.signal.aborted;
  const current = () =>
    !requestsRefused &&
    authorityCurrent() &&
    configGet('browser').enabled === true &&
    !closed &&
    !ownAbort.signal.aborted &&
    !requestsRefused;
  const runtimeOwners = createBrowserRuntimeOwnerResolution({
    db,
    authors: ownerAuthors,
    installationId: options.installationId,
    enabled: () => current() && !!proof,
  });
  const delegations = createRuntimeWorkspaceDelegations({
    db,
    owners: runtimeOwners,
    enabled: () => current() && !!proof,
    refuse: () => modeRefusal('AUTHORITY_REFUSED'),
  });
  const browserCloses = new WeakMap<
    ReturnType<typeof createProductionBrowserSession>,
    () => Promise<void>
  >();
  const browserPreparations = new WeakMap<
    ReturnType<typeof createProductionBrowserSession>,
    () => Promise<void>
  >();
  const captureBrowserClose = (browser: ReturnType<typeof createProductionBrowserSession>) => {
    let yes!: (method: () => Promise<void>) => void, no!: (reason: unknown) => void;
    const ready = new Promise<() => Promise<void>>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    browserCloses.set(browser, () => ready.then((method) => Reflect.apply(method, browser, [])));
    void ready.catch(() => {});
    try {
      const method = browser.close;
      if (typeof method !== 'function') throw modeRefusal('AUTHORITY_REFUSED');
      yes(method);
      const prepare = browser.prepareClose;
      if (typeof prepare !== 'function') throw modeRefusal('AUTHORITY_REFUSED');
      browserPreparations.set(browser, prepare.bind(browser));
    } catch (reason) {
      no(reason);
      throw reason;
    }
  };
  const stopBrowsers = () => {
    for (const browser of browsers) {
      try {
        const closing = browserCloses.get(browser)!();
        retain(closing);
        void closing.then(
          () => browsers.delete(browser),
          () => {}
        );
      } catch (reason) {
        first ??= Object.freeze({ value: reason });
      }
    }
  };
  const unsubscribe = subscribeConfig((change) => {
    if (change.paths.every((path) => path === 'browser.enabled' || path === 'browser')) {
      // Opt-in is not native authority. Every setting transition still disposes existing Pages;
      // installed original mode proof survives only if original files/auth remain current.
      stopBrowsers();
      return;
    }
    epoch++;
    proof = undefined;
    stopBrowsers();
  });
  const facts = (verified: InstallResult, actual: RuntimeInstallationStatus) => {
    if (
      verified.state !== 'verified-reused' ||
      verified.platform !== 'darwin' ||
      verified.arch !== 'arm64' ||
      actual.state !== 'installed-files' ||
      actual.installationId !== verified.installationId ||
      actual.executableSHA256 !== verified.executableSHA256 ||
      actual.currentManifestDigest !== verified.currentManifestDigest ||
      actual.lastFreshVerifiedVersion !== verified.observedVersion
    )
      throw modeRefusal('UNAVAILABLE');
  };
  const prepare = (): Promise<Proof> => {
    if (!authorityCurrent()) return Promise.reject(modeRefusal('UNAVAILABLE'));
    if (preparing) return preparing;
    const enteredEpoch = epoch;
    preparing = retain(
      Promise.resolve().then(async () => {
        const admit = () => {
          if (!authorityCurrent() || epoch !== enteredEpoch) throw modeRefusal('UNAVAILABLE');
        };
        admit();
        const original = await observeOriginalStartupPhase('mode.resolve-package', () => {
          admit();
          return resolveServerBrowserRuntimePackage();
        });
        admit();
        const verify = original.installation.verifyExisting.bind(original.installation),
          inspect = original.installation.inspectExisting.bind(original.installation);
        const existing = await observeOriginalStartupPhase('mode.inspect-initial', () => {
          admit();
          return inspect();
        });
        admit();
        if (existing.state === 'missing') throw originalStartupRefusal('runtimeMissing');
        if (existing.state === 'unsupported') throw originalStartupRefusal('unsupportedPlatform');
        const native = await observeOriginalStartupPhase('mode.native-journal', () => {
          admit();
          return verifyInstalledNativeJournal(original.configuration);
        });
        admit();
        const journal = native.journal;
        const verified = await observeOriginalStartupPhase('mode.verify-existing', () => {
          admit();
          return verify({ signal: ownAbort.signal });
        });
        admit();
        const actual = await observeOriginalStartupPhase('mode.inspect-after-verify', () => {
          admit();
          return inspect();
        });
        admit();
        facts(verified, actual);
        const after = await observeOriginalStartupPhase('mode.resolve-journal-after', () => {
          admit();
          return resolveInstalledNativeJournal(original.configuration);
        });
        admit();
        if (digest(after) !== digest(journal) || !authorityCurrent() || epoch !== enteredEpoch)
          throw modeRefusal('UNAVAILABLE');
        const owned = Object.freeze({ ...original, verified, journal, native });
        proof = owned;
        return owned;
      })
    );
    const originalPreparation = preparing;
    void originalPreparation.then(
      () => {
        // The settled proof remains private; release only the naturally settled preparation.
        // A later config epoch must be able to perform a fresh original verification.
        if (preparing === originalPreparation) preparing = undefined;
      },
      (reason) => {
        if (
          typeof reason === 'object' &&
          reason !== null &&
          originalStartupRefusals.has(reason) &&
          preparing === originalPreparation
        )
          preparing = undefined;
      }
    );
    return originalPreparation;
  };
  const captureOwner = async (headers: { cookie?: string }, signal: AbortSignal) => {
    if (
      !authorityCurrent() ||
      signal.aborted ||
      Buffer.byteLength(headers.cookie ?? '') > 8192 ||
      originals.size >= 64
    )
      throw modeRefusal('AUTHORITY_REFUSED');
    const enteredEpoch = epoch;
    const original = await retain(
      Promise.resolve().then(() => {
        if (!authorityCurrent() || signal.aborted || epoch !== enteredEpoch)
          throw modeRefusal('AUTHORITY_REFUSED');
        return observeOriginalStartupPhase('mode.capture-owner', () => {
          if (!authorityCurrent() || signal.aborted || epoch !== enteredEpoch)
            throw modeRefusal('AUTHORITY_REFUSED');
          return getSession({
            headers: fromNodeHeaders({ cookie: headers.cookie }),
            query: { disableCookieCache: true, disableRefresh: true },
          });
        });
      })
    );
    if (!authorityCurrent() || signal.aborted || epoch !== enteredEpoch)
      throw modeRefusal('AUTHORITY_REFUSED');
    const owner = findOwnerAccount(db);
    const credential = original?.session?.id
      ? db.select().from(session).where(eq(session.id, original.session.id)).get()
      : undefined;
    if (
      !owner ||
      !credential ||
      original?.user?.id !== owner.id ||
      credential.userId !== owner.id ||
      credential.expiresAt.getTime() <= Date.now()
    )
      throw modeRefusal('AUTHORITY_REFUSED');
    const before = digest(credential),
      id = owner.id;
    // Preserve the real existing local author when login binds it; never use user.id as authors.id.
    const author = bindOwnerAuthor(id);
    if (!authorityCurrent() || signal.aborted || epoch !== enteredEpoch)
      throw modeRefusal('AUTHORITY_REFUSED');
    const check = () => {
      if (!authorityCurrent() || signal.aborted || epoch !== enteredEpoch) return false;
      // Original mapping callbacks precede the final fresh account/session observations.
      if (!isOwnerAuthor(author.id, id)) return false;
      const nowOwner = findOwnerAccount(db),
        nowSession = db.select().from(session).where(eq(session.id, credential.id)).get();
      return (
        !closed &&
        !ownAbort.signal.aborted &&
        !signal.aborted &&
        epoch === enteredEpoch &&
        nowOwner?.id === id &&
        !!nowSession &&
        nowSession.expiresAt.getTime() > Date.now() &&
        digest(nowSession) === before
      );
    };
    if (!check()) throw modeRefusal('AUTHORITY_REFUSED');
    return Object.assign(check, { ownerId: author.id });
  };
  const inspectProof = (): Promise<Proof> =>
    retain(
      Promise.resolve().then(async () => {
        if (!authorityCurrent()) throw modeRefusal('UNAVAILABLE');
        const owned = proof ?? (await prepare());
        const admit = () => {
          if (!authorityCurrent() || proof !== owned) throw modeRefusal('UNAVAILABLE');
        };
        admit();
        const inspect = owned.installation.inspectExisting.bind(owned.installation);
        const actual = await retain(
          observeOriginalStartupPhase('mode.inspect-proof', () => {
            admit();
            return inspect();
          })
        );
        admit();
        facts(owned.verified, actual);
        await retain(
          observeOriginalStartupPhase('mode.native-proof', () => {
            admit();
            return verifyInstalledNativeJournal(owned.configuration);
          })
        );
        admit();
        const after = await retain(
          observeOriginalStartupPhase('mode.resolve-proof-journal', () => {
            admit();
            return resolveInstalledNativeJournal(owned.configuration);
          })
        );
        admit();
        if (digest(after) !== digest(owned.journal)) throw modeRefusal('UNAVAILABLE');
        return owned;
      })
    );
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, reject!: (reason: unknown) => void;
    closing = new Promise<void>((yes, no) => {
      done = yes;
      reject = no;
    });
    closed = true;
    delegations.close();
    fileApprovals.close();
    proof = undefined;
    try {
      ownAbort.abort();
    } catch (reason) {
      first ??= Object.freeze({ value: reason });
    }
    try {
      unsubscribe();
    } catch (reason) {
      first ??= Object.freeze({ value: reason });
    }
    stopBrowsers();
    void (async () => {
      while (originals.size) await Promise.allSettled([...originals]);
      if (first) reject(first.value);
      else done();
    })();
    return closing;
  };
  let transition: Promise<BrowserProductionStatus> | undefined;
  const status = async (
    headers: { cookie?: string },
    signal: AbortSignal
  ): Promise<BrowserProductionStatus> => {
    const actor = await captureOwner(headers, signal);
    if (!configGet('browser').enabled)
      return BrowserProductionStatusSchema.parse({
        state: 'disabled',
        enabled: false,
      });
    await inspectProof();
    const rows = db.select().from(workspaces).where(eq(workspaces.status, 'ready')).limit(65).all();
    if (rows.length > 64 || !actor() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
    const result = BrowserProductionStatusSchema.parse({
      state: 'ready',
      enabled: true,
      workspaces: rows.map((row) => ({ workspaceId: row.id, label: row.key })),
    });
    if (!actor() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
    return result;
  };
  const setEnabled = (
    enabled: boolean,
    headers: { cookie?: string },
    signal: AbortSignal
  ): Promise<BrowserProductionStatus> => {
    if (transition) return Promise.reject(modeRefusal('QUOTA'));
    let yes!: (value: BrowserProductionStatus) => void, no!: (value: unknown) => void;
    const work = retain(
      new Promise<BrowserProductionStatus>((resolve, reject) => {
        yes = resolve;
        no = reject;
      })
    );
    transition = work;
    void Promise.resolve()
      .then(async () => {
        const actor = await captureOwner(headers, signal);
        if (enabled) {
          const owned = await inspectProof(),
            admittedEpoch = epoch;
          if (!actor() || !authorityCurrent() || signal.aborted)
            throw modeRefusal('AUTHORITY_REFUSED');
          const permit = mintProductionBrowserEnablePermit(
            config,
            () => authorityCurrent() && epoch === admittedEpoch && proof === owned && actor()
          );
          enableOwnedBrowser(permit);
        } else {
          if (!actor() || !authorityCurrent()) throw modeRefusal('AUTHORITY_REFUSED');
          // The exact original setting write fences every mode.current before any close awaits.
          configSetDot('browser.enabled', false);
          stopBrowsers();
        }
        while ([...originals].some((original) => original !== work))
          await Promise.allSettled([...originals].filter((original) => original !== work));
        if (first) throw first.value;
        if (!actor() || configGet('browser').enabled !== enabled)
          throw modeRefusal('AUTHORITY_REFUSED');
        return enabled
          ? status(headers, signal)
          : BrowserProductionStatusSchema.parse({
              state: 'disabled',
              enabled: false,
            });
      })
      .then(yes, no);
    void work.then(
      () => {
        if (transition === work) transition = undefined;
      },
      () => {
        if (transition === work) transition = undefined;
      }
    );
    return work;
  };
  type OpenResult = Readonly<{
    browser: ReturnType<typeof createProductionBrowserSession>;
    result: Awaited<ReturnType<ReturnType<typeof createProductionBrowserSession>['open']>>;
  }>;
  type OriginalOpen = (
    headers: { cookie?: string },
    workspaceId: string,
    request: BrowserOpenRequest,
    signal: AbortSignal,
    initialUrl?: string
  ) => Promise<OpenResult>;
  const profileImports = new WeakMap<
    object,
    Readonly<{ profileId: string; state: BrowserStorageState }>
  >();
  const runtimeRequests = new WeakMap<object, RuntimeBrowserBirth>();
  const runtimeSubjects = new Map<
    ReturnType<typeof createProductionBrowserSession>,
    RuntimeBrowserBirth
  >();
  const fileApprovals = createRuntimeFileApprovals({
    db: options.db,
    enabled: () => current() && !!proof && configGet('browser').enabled,
    refuse: () => modeRefusal('AUTHORITY_REFUSED'),
    subject(binding) {
      if (!current() || !proof) throw modeRefusal('AUTHORITY_REFUSED');
      const matches = [...runtimeSubjects].filter(([browser]) => {
        const identity = browser.identity();
        return (
          identity?.browserId === binding.browserId &&
          identity.browserGeneration === binding.browserGeneration
        );
      });
      if (matches.length !== 1) throw modeRefusal('AUTHORITY_REFUSED');
      const [browser, birth] = matches[0]!;
      const browserCurrent = browser.current.bind(browser);
      const issue = browser.issueRuntimeFileGrant.bind(browser);
      return Object.freeze({
        birth,
        current: () => current() && browserCurrent() && birth.actor(),
        issue,
      });
    },
  });
  const api = Object.freeze({
    prepare,
    setEnabled,
    status,
    close,
    captureOwner,
    isOriginalStartupRefusal,
    registry,
    store,
    modeCurrent: () => current() && !!proof && configGet('browser').enabled,
    /** Discovery requires an existing genuine browser graph, never the saved preference alone. */
    allowLocalDestination(
      headers: { cookie?: string },
      value: BrowserLocalDestinationRequest,
      signal: AbortSignal,
      report: (value: BrokerError) => void
    ) {
      return retain(
        Promise.resolve().then(async () => {
          if (!current() || !proof) throw modeRefusal('AUTHORITY_REFUSED');
          const input = BrowserLocalDestinationRequestSchema.parse(value);
          const owner = await captureOwner(headers, signal);
          if (!owner() || !current() || signal.aborted) throw modeRefusal('AUTHORITY_REFUSED');
          const original = api.originalForBinding(input.binding);
          if (!original || !owner() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
          const endpoint = new URL(input.endpoint).origin;
          const expiresAt = new Date(Date.now() + input.ttlMilliseconds).toISOString();
          original.allowLocalDestination(
            input.binding,
            endpoint,
            input.ttlMilliseconds,
            owner,
            (reason) => {
              originalStartupRefusals.add(reason);
              report(reason);
            }
          );
          if (!owner() || !current() || signal.aborted) throw modeRefusal('AUTHORITY_REFUSED');
          return BrowserLocalDestinationReceiptSchema.parse({
            requestId: input.requestId,
            binding: input.binding,
            endpoint,
            expiresAt,
          });
        })
      );
    },
    describeRuntimeFileApproval(input: RuntimeFileApprovalInput) {
      if (!current() || !proof) throw modeRefusal('AUTHORITY_REFUSED');
      return fileApprovals.describe(input);
    },
    issueRuntimeFileApproval(context: CapabilityHandlerContext, input: RuntimeFileApprovalInput) {
      return retain(
        Promise.resolve().then(() => {
          if (!current() || !proof) throw modeRefusal('AUTHORITY_REFUSED');
          return fileApprovals.issue(input, context);
        })
      );
    },
    describeRuntimeDelegation(input: { workspaceId: string; sessionId: string }) {
      return delegations.describe(input);
    },
    openDelegatedForRuntime(
      principals: RuntimePrincipalService,
      authors: AuthorRegistry,
      context: CapabilityHandlerContext,
      input: {
        workspaceId: string;
        sessionId: string;
        request: BrowserOpenRequest;
        initialUrl?: string;
      }
    ): ReturnType<ManagedBrowserCapabilityDeps['open']> {
      return retain(
        Promise.resolve().then(() => {
          if (!current() || !proof || input.request.mode !== 'ephemeral')
            throw modeRefusal('AUTHORITY_REFUSED');
          const original = delegations.issue(input, input, context, principals, authors);
          return api.openForRuntime(
            principals,
            authors,
            context,
            input.request,
            input.initialUrl,
            original
          );
        })
      );
    },
    runtimeOptionalToolsAvailable() {
      if (!current() || !proof || !configGet('browser').enabled) return false;
      // List the declared constructor capability at turn construction, before browser birth.
      // Invocation still resolves the actual born session and recipient grant on every call.
      const available = hasProductionBrowserActorFactory();
      return available && current();
    },
    runtimeToolsAvailable() {
      if (!current() || !proof || !configGet('browser').enabled) return false;
      return current();
    },
    resolveRuntimeTools(
      binding: { browserId: string; browserGeneration: number },
      principals: RuntimePrincipalService,
      authors: AuthorRegistry
    ) {
      if (!current() || !proof || !configGet('browser').enabled)
        throw modeRefusal('AUTHORITY_REFUSED');
      const matches = [...browsers].filter((browser) => {
        const original = browser.identity();
        return (
          original?.browserId === binding.browserId &&
          original.browserGeneration === binding.browserGeneration
        );
      });
      if (matches.length !== 1 || !matches[0]!.current() || !current())
        throw modeRefusal('AUTHORITY_REFUSED');
      const original = matches[0]!.runtimeTools(principals, authors);
      if (!current() || !original.available()) throw modeRefusal('AUTHORITY_REFUSED');
      return original;
    },
    /** Join only original input-loss preparation before config listeners retire native authority. */
    async prepareDisable(): Promise<void> {
      const pending: Promise<unknown>[] = [];
      let primary: Readonly<{ value: unknown }> | undefined;
      const record = (value: unknown) => {
        primary ??= { value };
      };
      for (const browser of browsers) {
        try {
          const prepare = browserPreparations.get(browser);
          if (!prepare) throw modeRefusal('AUTHORITY_REFUSED');
          const work = prepare();
          void work.catch(record);
          pending.push(work);
        } catch (value) {
          record(value);
        }
      }
      for (const result of await Promise.allSettled(pending))
        if (result.status === 'rejected') record(result.reason);
      if (primary) throw primary.value;
    },
    /** Synchronous request admission only; original cleanup remains independently callable. */
    fenceRequests(value: unknown): void {
      requestsRefused = true;
      first ??= Object.freeze({ value });
    },
    originalForBinding(binding: { browserId: string; browserGeneration: number }) {
      const original = selectOriginalBrowserIdentity(
        browsers,
        binding,
        current,
        admissionDiagnostic
      );
      if (!original) throw modeRefusal('AUTHORITY_REFUSED');
      return original;
    },
    originalForAttachment(attachmentId: string) {
      const matches = [...browsers].filter((browser) => browser.ownsAttachment(attachmentId));
      if (matches.length !== 1 || !matches[0]!.current() || !current())
        throw modeRefusal('AUTHORITY_REFUSED');
      return matches[0]!;
    },
    originalForTicket(token: string) {
      const matches = [...browsers].filter((browser) => browser.ownsTicket(token));
      if (matches.length !== 1 || !matches[0]!.current()) throw modeRefusal('AUTHORITY_REFUSED');
      return matches[0]!;
    },
    /** Explicit owner import uses a new locked profile and joins original close before availability. */
    importProfile(
      headers: { cookie?: string },
      request: BrowserProductionProfileImportRequest,
      signal: AbortSignal
    ): Promise<import('@dorkos/shared/browser-schemas').BrowserProductionProfileImportReceipt> {
      return retain(
        Promise.resolve().then(async () => {
          const original = BrowserProductionProfileImportRequestSchema.parse(request),
            enteredEpoch = epoch;
          if (!current() || signal.aborted) throw modeRefusal('AUTHORITY_REFUSED');
          const actor = await captureOwner(headers, signal);
          const profiles = readProfiles(actor.ownerId);
          if (profiles.length >= 64) throw modeRefusal('QUOTA');
          if (measuredResources) resourceCheck(() => measuredResources.profiles(profiles.length));
          const valid = () => current() && actor() && !signal.aborted && epoch === enteredEpoch;
          if (!valid()) throw modeRefusal('AUTHORITY_REFUSED');
          const profile = store.beginProfileImport(actor.ownerId, original.label);
          const importHeaders = Object.freeze({ cookie: headers.cookie });
          profileImports.set(
            importHeaders,
            Object.freeze({ profileId: profile.profileId, state: original.storageState })
          );
          let completed: import('@dorkos/shared/browser-schemas').BrowserProfile | undefined;
          try {
            await importNewBrowserProfile({
              current: valid,
              open: () =>
                api.open(
                  importHeaders,
                  original.workspaceId,
                  {
                    requestId: original.requestId,
                    mode: 'persistent',
                    profileId: profile.profileId,
                  },
                  signal
                ),
              async close(acquired) {
                // Cleanup uses the already captured owner/binding, even after request cancellation.
                await joinProductionBrowserClose(
                  () => retain(browserCloses.get(acquired.browser)!()),
                  () =>
                    registry.stop(
                      actor.ownerId,
                      acquired.result.opened.browserId,
                      acquired.result.opened.browserGeneration
                    )
                );
                browsers.delete(acquired.browser);
                const row = store.instance(
                  actor.ownerId,
                  acquired.result.opened.browserId,
                  acquired.result.opened.browserGeneration
                );
                if (row.status !== 'stopped') throw modeRefusal('AUTHORITY_REFUSED');
              },
              finish(observed) {
                completed = store.finishProfileImport(actor.ownerId, profile.profileId, observed);
              },
            });
            return BrowserProductionProfileImportReceiptSchema.parse({
              requestId: original.requestId,
              profile: completed,
            });
          } finally {
            profileImports.delete(importHeaders);
          }
        })
      );
    },
    /** Metadata creation never starts a browser or seeds clean-mode storage. */
    createProfile(
      headers: { cookie?: string },
      request: BrowserProductionProfileCreateRequest,
      signal: AbortSignal
    ) {
      let yes!: (
          value: import('@dorkos/shared/browser-schemas').BrowserProductionProfileCreateReceipt
        ) => void,
        no!: (value: unknown) => void;
      const work = retain(
        new Promise<import('@dorkos/shared/browser-schemas').BrowserProductionProfileCreateReceipt>(
          (resolve, reject) => {
            yes = resolve;
            no = reject;
          }
        )
      );
      void Promise.resolve()
        .then(async () => {
          const original = BrowserProductionProfileCreateRequestSchema.parse(request),
            enteredEpoch = epoch;
          if (!current() || signal.aborted) throw modeRefusal('AUTHORITY_REFUSED');
          const actor = await captureOwner(headers, signal);
          const profiles = readProfiles(actor.ownerId);
          if (profiles.length >= 64) throw modeRefusal('QUOTA');
          if (measuredResources) resourceCheck(() => measuredResources.profiles(profiles.length));
          if (
            !current() ||
            !actor() ||
            signal.aborted ||
            closed ||
            ownAbort.signal.aborted ||
            epoch !== enteredEpoch
          )
            throw modeRefusal('AUTHORITY_REFUSED');
          const profile = createProfile(actor.ownerId, original.label);
          if (
            !current() ||
            !actor() ||
            signal.aborted ||
            closed ||
            ownAbort.signal.aborted ||
            epoch !== enteredEpoch
          )
            throw modeRefusal('AUTHORITY_REFUSED');
          return BrowserProductionProfileCreateReceiptSchema.parse({
            requestId: original.requestId,
            profile,
          });
        })
        .then(yes, no);
      return work;
    },
    /** Independent runtime birth uses the current turn's actual owned workspace, never owner cookies. */
    openForRuntime(
      principals: RuntimePrincipalService,
      authors: AuthorRegistry,
      context: CapabilityHandlerContext,
      request: BrowserOpenRequest,
      initialUrl?: string,
      delegation?: RuntimeWorkspaceDelegation
    ) {
      return retain(
        Promise.resolve().then(async () => {
          if (request.mode !== 'ephemeral') throw modeRefusal('AUTHORITY_REFUSED');
          const signal = context.signal ?? new AbortController().signal;
          const runtime = await captureRuntimeBrowserBirth({
            db,
            principals,
            authors,
            context,
            owners: runtimeOwners,
            enabled: () => current() && !!proof && configGet('browser').enabled,
            delegation,
            refuse: () => modeRefusal('AUTHORITY_REFUSED'),
          });
          if (!runtime.actor() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
          // Expired agent turns do not accumulate in the finite browser bank. Metadata loss
          // alone is not closure: join the exact retained native/session close before removal.
          for (const [oldBrowser, oldTurn] of [...runtimeSubjects]) {
            if (oldTurn.actor()) continue;
            if (!current() || !runtime.actor()) throw modeRefusal('AUTHORITY_REFUSED');
            const close = browserCloses.get(oldBrowser);
            if (!close) throw modeRefusal('AUTHORITY_REFUSED');
            await retain(close());
            if (runtimeSubjects.get(oldBrowser) === oldTurn) {
              runtimeSubjects.delete(oldBrowser);
              browsers.delete(oldBrowser);
            }
            if (!current() || !runtime.actor()) throw modeRefusal('AUTHORITY_REFUSED');
          }
          const headers = Object.freeze({});
          runtimeRequests.set(headers, runtime);
          let opened: OpenResult;
          try {
            opened = await originalOpen(headers, runtime.workspaceId, request, signal, initialUrl);
          } finally {
            runtimeRequests.delete(headers);
          }
          if (!runtime.actor() || !current() || !opened.browser.current())
            throw modeRefusal('AUTHORITY_REFUSED');
          runtimeSubjects.set(opened.browser, runtime);
          return Object.freeze({
            instance: opened.result.instance,
            binding: opened.result.binding,
            grant: opened.browser.runtimeGrant(),
          });
        })
      );
    },
    /** Close only an original browser born for this same live runtime turn and durable recipient. */
    closeForRuntime(
      principals: RuntimePrincipalService,
      authors: AuthorRegistry,
      context: CapabilityHandlerContext,
      binding: { browserId: string; browserGeneration: number }
    ) {
      return retain(
        Promise.resolve().then(async () => {
          const selected = [...runtimeSubjects].filter(([browser]) => {
            const identity = browser.identity();
            return (
              identity?.browserId === binding.browserId &&
              identity.browserGeneration === binding.browserGeneration
            );
          });
          if (selected.length !== 1) throw modeRefusal('AUTHORITY_REFUSED');
          const runtime = await captureRuntimeBrowserBirth({
            db,
            principals,
            authors,
            context,
            owners: runtimeOwners,
            enabled: () => current() && !!proof && configGet('browser').enabled,
            refuse: () => modeRefusal('AUTHORITY_REFUSED'),
            delegation: selected[0]![1].delegation,
          });
          const matches = [...runtimeSubjects].filter(([browser, original]) => {
            const identity = browser.identity();
            return (
              original.principal.claims.kind === 'runtime' &&
              runtime.principal.claims.kind === 'runtime' &&
              original.principal.claims.bindingId === runtime.principal.claims.bindingId &&
              original.recipientId === runtime.recipientId &&
              identity?.browserId === binding.browserId &&
              identity.browserGeneration === binding.browserGeneration
            );
          });
          if (matches.length !== 1 || !runtime.actor()) throw modeRefusal('AUTHORITY_REFUSED');
          const [browser, original] = matches[0]!;
          if (!original.actor() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
          await joinProductionBrowserClose(
            () => retain(browserCloses.get(browser)!()),
            () => registry.stop(runtime.actor.ownerId, binding.browserId, binding.browserGeneration)
          );
          if (!runtime.actor() || !current()) throw modeRefusal('AUTHORITY_REFUSED');
          browsers.delete(browser);
          runtimeSubjects.delete(browser);
          const instance = registry.instance(
            runtime.actor.ownerId,
            binding.browserId,
            binding.browserGeneration
          );
          if (instance.status !== 'stopped') throw modeRefusal('AUTHORITY_REFUSED');
          return instance;
        })
      );
    },
    /** Retain the genuine session before its first auth/native/browser acquisition. */
    open(
      headers: { cookie?: string },
      workspaceId: string,
      request: BrowserOpenRequest,
      signal: AbortSignal,
      initialUrl?: string
    ) {
      let done!: (
        value: Readonly<{
          browser: ReturnType<typeof createProductionBrowserSession>;
          result: Awaited<ReturnType<ReturnType<typeof createProductionBrowserSession>['open']>>;
        }>
      ) => void;
      let reject!: (value: unknown) => void;
      const work = retain(
        new Promise<
          Readonly<{
            browser: ReturnType<typeof createProductionBrowserSession>;
            result: Awaited<ReturnType<ReturnType<typeof createProductionBrowserSession>['open']>>;
          }>
        >((yes, no) => {
          done = yes;
          reject = no;
        })
      );
      void (async () => {
        const originalRequest = BrowserOpenRequestSchema.parse(request);
        const initializing = profileImports.get(headers);
        if (
          initializing &&
          (originalRequest.mode !== 'persistent' ||
            originalRequest.profileId !== initializing.profileId)
        )
          throw modeRefusal('AUTHORITY_REFUSED');
        if (!current() || browsers.size >= 16 || !configGet('browser').enabled)
          throw modeRefusal('AUTHORITY_REFUSED');
        const runtime = runtimeRequests.get(headers);
        const actorCurrent = runtime ? runtime.actor : await captureOwner(headers, signal),
          owned = await inspectProof();
        if (
          owned.verified.state !== 'verified-reused' ||
          !actorCurrent() ||
          !configGet('browser').enabled
        )
          throw modeRefusal('AUTHORITY_REFUSED');
        if (browsers.size >= 16) throw modeRefusal('QUOTA');
        if (measuredResources) {
          // Capture from the actually verified arm before crossing the callback boundary.
          const executableSHA256 = owned.verified.executableSHA256;
          resourceCheck(() => measuredResources.browser(executableSHA256, browsers.size));
        }
        if (originalRequest.mode === 'persistent') {
          const profile = readProfiles(actorCurrent.ownerId).find(
            (value) => value.profileId === originalRequest.profileId
          );
          if (
            !profile ||
            (store.isProfileImport(actorCurrent.ownerId, originalRequest.profileId)
              ? initializing?.profileId !== originalRequest.profileId
              : profile.status !== 'available')
          )
            throw modeRefusal('AUTHORITY_REFUSED');
        }
        const originalChromeUserAgent = configGet('browser').chromeUserAgent === true;
        const enteredEpoch = epoch;
        const valid = () =>
          current() &&
          epoch === enteredEpoch &&
          proof === owned &&
          configGet('browser').enabled &&
          (configGet('browser').chromeUserAgent === true) === originalChromeUserAgent &&
          actorCurrent();
        const configured = validateEngineConfiguration({
          dataDir: join(resolveDorkHome(), 'browser'),
          runtime: {
            library: {
              package: 'playwright-core',
              version: '1.63.0',
              rootDir: owned.configuration.libraryRoot,
              assets: { manifest: 'browsers.json', cli: 'cli.js' },
            },
            executable: {
              path: join(
                owned.configuration.cacheRoot,
                'candidates',
                owned.verified.installationId,
                'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
              ),
              sha256: owned.verified.executableSHA256,
              revision: '1243',
              version: owned.verified.observedVersion,
              platform: 'darwin',
              arch: 'arm64',
            },
            identity: {
              mode: originalChromeUserAgent ? 'chrome-compatible' : 'native',
              policyRevision: 1,
            },
          },
          network: { kind: 'owned', origin: 'about:blank', policyRevision: 1 },
          clock: {
            wallNow: Date.now,
            monotonicNow: () => Number(process.hrtime.bigint() / 1000000n),
          },
          ...(measuredResources
            ? {
                captureMinimumIntervalMilliseconds:
                  measuredResources.captureMinimumIntervalMilliseconds,
              }
            : {}),
          processes: owned.native.processes,
          nativeJournal: owned.journal,
          // The production composition installs its original grant/lease decisions before construction.
          // This uncomposed configuration confers no ordinary action or forwarding permission.
          policy: {
            authorizeAction: async () => 'refused',
            verifyBrokerLease: async () => 'unknown',
          },
        });
        if (configured.network.kind !== 'owned' || !valid()) throw modeRefusal('AUTHORITY_REFUSED');
        const admission = Object.freeze({
          kind: 'production-browser-mode' as const,
        });
        modes.set(
          admission,
          Object.freeze({
            ownerId: actorCurrent.ownerId,
            ...(resourceAcceptance ? { resourceAcceptance } : {}),
            ...(viewerSamples ? { viewerSamples } : {}),
            current: valid,
            configuration: { ...configured, network: configured.network },
          })
        );
        if (measuredResources) {
          resourceCheck(() => measuredResources.browserCount(browsers.size));
          if (!valid()) throw modeRefusal('AUTHORITY_REFUSED');
        }
        const browser = createProductionBrowserSession({
          db: db,
          auth: auth,
          config: config,
          registry,
          store,
          inventory: inventory,
          admission,
        });
        browsers.add(browser);
        captureBrowserClose(browser);
        if (!valid()) {
          const refusal = first ?? Object.freeze({ value: modeRefusal('AUTHORITY_REFUSED') });
          first ??= refusal;
          try {
            await retain(browserCloses.get(browser)!());
          } catch (value) {
            first ??= Object.freeze({ value });
          }
          throw refusal.value;
        }
        const result = await retain(
          browser.open(
            headers,
            workspaceId,
            originalRequest,
            signal,
            initialUrl,
            runtime,
            initializing?.state
          )
        );
        if (!valid() || !browser.current()) {
          await retain(browserCloses.get(browser)!());
          throw modeRefusal('AUTHORITY_REFUSED');
        }
        return Object.freeze({ browser, result });
      })().then(done, reject);
      return work;
    },
    async closeBrowser(
      headers: { cookie?: string },
      browserId: string,
      browserGeneration: number,
      signal: AbortSignal
    ) {
      const actorCurrent = await captureOwner(headers, signal);
      const matches = [...browsers].filter((browser) => {
        const original = browser.identity();
        return (
          original?.ownerId === actorCurrent.ownerId &&
          original.browserId === browserId &&
          original.browserGeneration === browserGeneration
        );
      });
      if (matches.length !== 1 || !actorCurrent()) throw modeRefusal('AUTHORITY_REFUSED');
      // Session close synchronously fences ordinary callers and drains original seat reset
      // before network/native retirement. Registry.stop must not retire that engine first.
      await joinProductionBrowserClose(
        () => retain(browserCloses.get(matches[0]!)!()),
        () => registry.stop(actorCurrent.ownerId, browserId, browserGeneration)
      );
      browsers.delete(matches[0]!);
      const result = registry.instance(actorCurrent.ownerId, browserId, browserGeneration);
      if (result.status !== 'stopped' || !actorCurrent()) throw modeRefusal('AUTHORITY_REFUSED');
    },
  });
  const originalOpen: OriginalOpen = api.open.bind(api);
  return api;
}
