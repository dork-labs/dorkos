import {
  createOriginalBrowserViewerDiagnostic,
  type BrowserViewerDiagnosticStage,
} from '../../../stream/viewer-diagnostic.js';
import type { BrowserRuntimeOwnerResolution } from '../../../runtime/runtime-owner-resolution.js';
import nodePath from 'node:path';
import {
  captureRuntimeWorkspaceDelegation,
  type RuntimeWorkspaceDelegation,
} from '../../../runtime/runtime-workspace-delegation.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import { validateEngineConfiguration } from '@dorkos/browser';
import type { createProductionBrowserRuntimeOwner } from '../../../runtime/production-owner.js';
import { createHash } from 'node:crypto';
import { session, workspaces, connectorRuntimeBindings, eq, type Db } from '@dorkos/db';
import { fromNodeHeaders, type Auth } from '../../../../core/auth/index.js';
import { findOwnerAccount } from '../../../../core/auth/accounts.js';
import type { ConfigManager } from '../../../../core/config-manager.js';
import {
  constructOwnedBrowserEngine,
  type BrowserLifecycleEngine,
  type PrivateBrowserBirthOwner,
  type PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import type { AuthorityPorts, AuthorityObservation } from '../authority.js';
import type { EgressBinding, EgressPolicyOptions } from '../../settings.js';
import type { createServerInventory } from '../server-inventory.js';
import { BrokerError } from '../errors.js';
import { bounded, checkedClock } from '../clock.js';

/** One-use server consent, held only in this process and never accepted from proxy JSON. */
export interface PrivateWorkspaceBrowserGrant {
  readonly kind: 'private-workspace-browser-grant';
}
type Grant = {
  ownerId: string;
  workspaceId: string;
  sessionId?: string;
  sessionDigest?: string;
  runtime?: Readonly<{
    principal: ServerPrincipalProof;
    current(): boolean;
    accountCurrent(): boolean;
    delegated?: Readonly<{
      workspaceId: string;
      path: string;
      current(): boolean;
    }>;
  }>;
  workspaceDigest: string;
  epoch: number;
  used: boolean;
  revoked: boolean;
};
type Original = {
  receiver: PrivateBrowserRetirementReceiver;
  grant: Grant;
  active: boolean;
  retirementStarted: boolean;
  ordinary?: () => boolean;
  current?: () => boolean;
  revoke?: PrivateBrowserRetirementReceiver['authorityRevoked'];
  runtime?: PrivateBrowserRetirementReceiver['verifiedRuntimeBinding'];
  verifiedRuntime?: Readonly<{
    runtimeIdentity: string;
    policyRevision: number;
  }>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Constructor-only registry/input/capture participants; the live broker retains network ownership. */
export type PrivateLiveBrowserParticipants = Pick<
  PrivateBrowserBirthOwner,
  | 'registerBirth'
  | 'refuseBirth'
  | 'input'
  | 'capture'
  | 'navigation'
  | 'upload'
  | 'download'
  | 'semantic'
  | 'resources'
> & {
  /** Bind original current-tab authority before the first birth callback/open. */
  bindEngine?(engine: BrowserLifecycleEngine): void;
};

/** Exact private peer returned by the server-owned cold listener. */
export interface PrivateLiveNetworkPeer {
  readonly authenticationWarmup?: Readonly<{ url: string; confirm(): Promise<void> }>;
  readonly url: string;
  readonly credentials: Readonly<{ username: string; password: string }>;
  isCustodyKnown(): boolean;
  close(): Promise<void>;
}
/** Trusted composition hooks; no request DTO can select an original receiver. */
export interface PrivateLiveNetworkPreparation {
  prepare(
    context: Readonly<{
      receiver: PrivateBrowserRetirementReceiver;
      binding: EgressBinding;
      authorizationEpoch: number;
      runtimeIdentity: string;
      policyRevision: number;
    }>
  ): Promise<PrivateLiveNetworkPeer>;
  activate(receiver: PrivateBrowserRetirementReceiver, peer: PrivateLiveNetworkPeer): Promise<void>;
}

/**
 * Internal real authenticated original authority. Entry factories select fixture versus fresh-native
 * construction; current SQL/session/workspace facts are re-read at every forwarding fence.
 */
export function createBrowserAuthorityCore(
  options: {
    db: Db;
    auth: Auth;
    config: Pick<ConfigManager, 'get' | 'onChange'>;
    inventory: ReturnType<typeof createServerInventory>;
    policyRevision: number;
    now: () => number;
    checkOwnedOrigins?: (binding: EgressBinding) => void;
    readPreparedPolicy?: (
      binding: EgressBinding,
      receiver: PrivateBrowserRetirementReceiver
    ) => EgressPolicyOptions;
  },
  runtimeOwner?: ReturnType<typeof createProductionBrowserRuntimeOwner>
) {
  if (!Number.isSafeInteger(options.policyRevision) || options.policyRevision < 0)
    throw new BrokerError('UNAVAILABLE');
  const originalGetSession = options.auth.api.getSession.bind(options.auth.api);
  const admissionDiagnostic = createOriginalBrowserViewerDiagnostic();
  const grants = new WeakMap<PrivateWorkspaceBrowserGrant, Grant>();
  const originals = new Map<string, Original>();
  const retainedOperations = new Set<Promise<unknown>>();
  let retainedFailure: Readonly<{ value: unknown }> | undefined;
  let authorizationAttempts = 0;
  let epoch = 1,
    stopped = false;
  const now = checkedClock(options.now, () => {
    stopped = true;
  });
  const retain = <T>(original: Promise<T>): Promise<T> => {
    retainedOperations.add(original);
    void original.then(
      () => retainedOperations.delete(original),
      (reason) => {
        retainedFailure ??= Object.freeze({ value: reason });
        retainedOperations.delete(original);
      }
    );
    return original;
  };
  const authenticate = (request: Parameters<typeof originalGetSession>[0]) => {
    authorizationAttempts++;
    // Reserve and retain work before the exact captured method can throw/reenter. Synchronous
    // throws become the original retained work rejection and release only at known settlement.
    const owned = retain(Promise.resolve().then(() => originalGetSession(request)));
    const settled = () => {
      authorizationAttempts--;
    };
    void owned.then(settled, settled);
    return owned;
  };
  const retire = (original: Original) => {
    original.active = false;
    if (original.retirementStarted) return;
    original.retirementStarted = true;
    original.grant.revoked = true;
    try {
      if (!original.revoke) throw new BrokerError('AUTHORITY_REFUSED');
      retain(Promise.resolve().then(() => Reflect.apply(original.revoke!, original.receiver, [])));
    } catch (reason) {
      retainedFailure ??= Object.freeze({ value: reason });
    }
  };
  const unsubscribe = options.config.onChange((change) => {
    // These sections select browser identity/auth authority or the protected tunnel surface.
    // UI preference writes do not change the retained browser's authority or native proof.
    if (
      !change.paths.some((path) =>
        ['browser', 'auth', 'tunnel'].some(
          (section) => path === section || path.startsWith(section + '.')
        )
      )
    )
      return;
    if (epoch === Number.MAX_SAFE_INTEGER) stopped = true;
    else epoch++;
    for (const original of originals.values()) retire(original);
  });
  const key = (value: Pick<EgressBinding, 'browserId' | 'browserGeneration'>) =>
    `${value.browserId}:${value.browserGeneration}`;
  const facts = (grant: Grant, decision?: { stage: BrowserViewerDiagnosticStage }) => {
    // Only the owned readCurrent stack supplies this data cell. No observer enters facts.
    const stage = (value: BrowserViewerDiagnosticStage) => {
      if (decision) decision.stage = value;
    };
    stage('facts.stopped');
    if (stopped) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.revoked');
    if (grant.revoked) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.epoch');
    if (grant.epoch !== epoch) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.auth');
    if (options.config.get('auth').enabled !== true) throw new BrokerError('AUTHORITY_REFUSED');
    if (grant.runtime) {
      stage('facts.runtime');
      const claims = grant.runtime.principal.claims;
      if (
        claims.kind !== 'runtime' ||
        grant.runtime.current() !== true ||
        grant.runtime.accountCurrent() !== true ||
        (grant.runtime.delegated && grant.runtime.delegated.current() !== true)
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      const owner = findOwnerAccount(options.db);
      const credential = options.db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, claims.bindingId))
        .get();
      const workspace = options.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, grant.workspaceId))
        .get();
      const utcNow = Date.now();
      const utcExpiresAt = credential ? Date.parse(credential.expiresAt) : NaN;
      if (
        owner?.id !== grant.ownerId ||
        (claims.owner.kind === 'user' && claims.owner.userId !== grant.ownerId) ||
        !credential ||
        credential.revokedAt ||
        credential.ownerKind !== claims.owner.kind ||
        credential.ownerId !==
          (claims.owner.kind === 'user' ? claims.owner.userId : claims.owner.installationId) ||
        credential.agentId !== claims.agentId ||
        credential.agentPath !== claims.agentPath ||
        credential.canonicalSessionId !== claims.canonicalSessionId ||
        credential.runtime !== claims.runtime ||
        credential.canonicalCwd !== claims.canonicalCwd ||
        !Number.isFinite(utcExpiresAt) ||
        utcExpiresAt <= utcNow ||
        !workspace ||
        (grant.runtime.delegated
          ? workspace.ownerKind !== null ||
            workspace.ownerRef !== null ||
            workspace.id !== grant.runtime.delegated.workspaceId ||
            workspace.path !== grant.runtime.delegated.path
          : workspace.ownerKind !== 'agent' || workspace.ownerRef !== claims.agentPath) ||
        workspace.status !== 'ready' ||
        digest(workspace) !== grant.workspaceDigest ||
        !claims.canonicalCwd ||
        !nodePath.isAbsolute(claims.canonicalCwd) ||
        !nodePath.isAbsolute(workspace.path)
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      const relative = nodePath.relative(workspace.path, claims.canonicalCwd);
      if (
        relative === '..' ||
        relative.startsWith('..' + nodePath.sep) ||
        nodePath.isAbsolute(relative) ||
        stopped ||
        grant.revoked ||
        grant.epoch !== epoch
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      return { utcNow, utcExpiresAt };
    }
    stage('facts.session-id');
    if (!grant.sessionId) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.owner-read');
    const owner = findOwnerAccount(options.db);
    stage('facts.session-read');
    const credential = options.db
      .select()
      .from(session)
      .where(eq(session.id, grant.sessionId))
      .get();
    stage('facts.workspace-read');
    const workspace = options.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, grant.workspaceId))
      .get();
    stage('facts.clock');
    const utcNow = Date.now();
    stage('facts.owner');
    if (owner?.id !== grant.ownerId) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.session');
    if (!credential) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.session-owner');
    if (credential.userId !== grant.ownerId) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.session-expired');
    if (credential.expiresAt.getTime() <= utcNow) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.session-changed');
    if (digest(credential) !== grant.sessionDigest) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.workspace');
    if (!workspace) throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.workspace-status');
    if (workspace.status !== 'ready') throw new BrokerError('AUTHORITY_REFUSED');
    stage('facts.workspace-changed');
    if (digest(workspace) !== grant.workspaceDigest) throw new BrokerError('AUTHORITY_REFUSED');
    return { utcNow, utcExpiresAt: credential.expiresAt.getTime() };
  };
  const verifiedRuntime = (original: Original) => {
    const proof = original.runtime?.();
    if (
      !proof ||
      !/^[a-f0-9]{64}$/.test(proof.runtimeIdentity) ||
      proof.policyRevision !== options.policyRevision ||
      (original.verifiedRuntime &&
        (original.verifiedRuntime.runtimeIdentity !== proof.runtimeIdentity ||
          original.verifiedRuntime.policyRevision !== proof.policyRevision))
    )
      throw new BrokerError('AUTHORITY_REFUSED');
    if (!original.verifiedRuntime) original.verifiedRuntime = Object.freeze({ ...proof });
    return original.verifiedRuntime;
  };
  const readCurrent = (binding: EgressBinding): AuthorityObservation => {
    const original = originals.get(key(binding));
    const decision: { stage: BrowserViewerDiagnosticStage } = { stage: 'authority.original' };
    try {
      if (!original) throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.active';
      if (!original.active) throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.owner';
      if (binding.ownerId !== original.grant.ownerId) throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.workspace';
      if (binding.workspaceId !== original.grant.workspaceId)
        throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.ordinary';
      if (original.ordinary?.() !== true) throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.current';
      if (original.current?.() !== true) throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.native';
      if (runtimeOwner && !runtimeOwner.isOriginalNativeCurrent(original.receiver))
        throw new BrokerError('AUTHORITY_REFUSED');
      decision.stage = 'authority.origins';
      options.checkOwnedOrigins?.(binding);
      decision.stage = 'authority.runtime';
      const runtime = verifiedRuntime(original);
      const times = facts(original.grant, decision);
      decision.stage = 'authority.inventory';
      const inventory = options.inventory.readInventory();
      return Object.freeze({
        binding: Object.freeze({ ...binding }),
        ownerExists: true,
        retainedRun: true,
        grantsCurrent: true,
        custodyKnown: true,
        runtimePolicyKnown: true,
        runtimeIdentity: runtime.runtimeIdentity,
        authorizationEpoch: epoch,
        policyRevision: options.policyRevision,
        inventoryRevision: inventory.revision,
        monotonicNow: ((decision.stage = 'authority.clock'), now()),
        ...times,
      });
    } catch (error) {
      if (original) retire(original);
      admissionDiagnostic.failure(decision.stage, error);
      throw error;
    }
  };
  const ports: AuthorityPorts = Object.freeze({
    readCurrent,
    async readAuthority(binding: EgressBinding, signal: AbortSignal) {
      if (signal.aborted) throw new BrokerError('AUTHORITY_REFUSED');
      await Promise.resolve();
      if (signal.aborted) throw new BrokerError('AUTHORITY_REFUSED');
      return readCurrent(binding);
    },
    readInventory: options.inventory.readInventory,
    ...(options.readPreparedPolicy
      ? {
          readPreparedPolicy(binding: EgressBinding, receiver: unknown) {
            const original = originals.get(key(binding));
            if (!original || original.receiver !== receiver)
              throw new BrokerError('AUTHORITY_REFUSED');
            readCurrent(binding); // Actual ready original and fresh SQL/config/runtime before sealing.
            try {
              return options.readPreparedPolicy!(binding, original.receiver);
            } catch (error) {
              retire(original);
              throw error;
            }
          },
        }
      : {}),
  });
  return Object.freeze({
    ports,
    /** A genuine runtime turn may acquire its agent-owned workspace or exact owner-approved delegation.
     * The original principal service and SQLite binding remain live at every broker fence. */
    authorizeRuntimeWorkspace(
      principals: RuntimePrincipalService,
      principal: ServerPrincipalProof,
      workspaceId: string,
      signal: AbortSignal,
      delegation?: RuntimeWorkspaceDelegation,
      owners?: BrowserRuntimeOwnerResolution
    ): Promise<PrivateWorkspaceBrowserGrant> {
      if (
        !isServerPrincipal(principal) ||
        principal.claims.kind !== 'runtime' ||
        (!owners && principal.claims.owner.kind !== 'user') ||
        stopped ||
        signal.aborted ||
        authorizationAttempts >= 64 ||
        options.config.get('auth').enabled !== true
      )
        return Promise.reject(new BrokerError('AUTHORITY_REFUSED'));
      const claims = principal.claims;
      const revalidate = principals.revalidatePrincipal.bind(principals),
        current = principals.isPrincipalCurrent.bind(principals);
      const mappedOwner = owners?.resolve(
        principal,
        () => !stopped && !signal.aborted && current(principal)
      );
      const accountId =
        mappedOwner?.accountId ??
        (!owners && claims.owner.kind === 'user' ? claims.owner.userId : undefined);
      if (!accountId || (owners && !mappedOwner))
        return Promise.reject(new BrokerError('AUTHORITY_REFUSED'));
      const accountCurrent = () =>
        mappedOwner ? mappedOwner.current() : findOwnerAccount(options.db)?.id === accountId;
      const enteredEpoch = epoch;
      authorizationAttempts++;
      const original = retain(
        Promise.resolve().then(async () => {
          if (stopped || signal.aborted || enteredEpoch !== epoch || !current(principal))
            throw new BrokerError('AUTHORITY_REFUSED');
          if (!(await revalidate(principal)) || stopped || signal.aborted || enteredEpoch !== epoch)
            throw new BrokerError('AUTHORITY_REFUSED');
          const delegated = delegation
            ? captureRuntimeWorkspaceDelegation(delegation, principal)
            : undefined;
          if (delegated && delegated.workspaceId !== workspaceId)
            throw new BrokerError('AUTHORITY_REFUSED');
          if (stopped || signal.aborted || enteredEpoch !== epoch)
            throw new BrokerError('AUTHORITY_REFUSED');
          const workspace = options.db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .get();
          if (!workspace) throw new BrokerError('AUTHORITY_REFUSED');
          const grant: Grant = {
            ownerId: accountId,
            workspaceId,
            workspaceDigest: digest(workspace),
            epoch: enteredEpoch,
            used: false,
            revoked: false,
            runtime: Object.freeze({
              principal,
              current: () => current(principal),
              accountCurrent,
              ...(delegated ? { delegated } : {}),
            }),
          };
          facts(grant);
          if (stopped || signal.aborted || enteredEpoch !== epoch)
            throw new BrokerError('AUTHORITY_REFUSED');
          const capability = Object.freeze({
            kind: 'private-workspace-browser-grant' as const,
          });
          grants.set(capability, grant);
          return capability;
        })
      );
      const settled = () => {
        authorizationAttempts--;
      };
      void original.then(settled, settled);
      return bounded(original, 2000);
    },
    async authorizeWorkspace(
      headers: { cookie?: string },
      workspaceId: string,
      signal: AbortSignal
    ): Promise<PrivateWorkspaceBrowserGrant> {
      if (
        stopped ||
        signal.aborted ||
        authorizationAttempts >= 64 ||
        Buffer.byteLength(headers.cookie ?? '') > 8192 ||
        options.config.get('auth').enabled !== true
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      // Reserve before invoking the original auth operation. Unknown or timed-out
      // callers retain their slot until the actual original auth callback naturally settles.
      const enteredEpoch = epoch;
      // Original auth call remains retained if the bounded caller wait expires.
      const original = authenticate({
        headers: fromNodeHeaders({ cookie: headers.cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      const authenticated = await bounded(original, 2000);
      if (
        signal.aborted ||
        enteredEpoch !== epoch ||
        !authenticated?.session?.id ||
        !authenticated.user?.id
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      const credential = options.db
        .select()
        .from(session)
        .where(eq(session.id, authenticated.session.id))
        .get();
      const workspace = options.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .get();
      if (!credential || !workspace) throw new BrokerError('AUTHORITY_REFUSED');
      const grant: Grant = {
        ownerId: authenticated.user.id,
        workspaceId,
        sessionId: credential.id,
        sessionDigest: digest(credential),
        workspaceDigest: digest(workspace),
        epoch,
        used: false,
        revoked: false,
      };
      facts(grant);
      const capability = Object.freeze({
        kind: 'private-workspace-browser-grant' as const,
      });
      grants.set(capability, grant);
      return capability;
    },
    /** Reauthenticate this incoming request against the exact original owner session/workspace.
     * No cookie/body identity or a second owner's valid session can drive an older retained grant. */
    async authorizeWorkspaceRequest(
      capability: PrivateWorkspaceBrowserGrant,
      headers: { cookie?: string },
      signal: AbortSignal
    ) {
      const grant = grants.get(capability);
      if (
        !grant ||
        grant.runtime ||
        authorizationAttempts >= 64 ||
        signal.aborted ||
        Buffer.byteLength(headers.cookie ?? '') > 8192
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      facts(grant);
      const enteredEpoch = epoch;
      const authenticated = await bounded(
        authenticate({
          headers: fromNodeHeaders({ cookie: headers.cookie }),
          query: { disableCookieCache: true, disableRefresh: true },
        }),
        2000
      );
      if (
        signal.aborted ||
        stopped ||
        enteredEpoch !== epoch ||
        authenticated?.session?.id !== grant.sessionId ||
        authenticated?.user?.id !== grant.ownerId
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      facts(grant);
    },
    /** Called only by the private constructor composition, before its original engine birth. */
    openEngine(
      capability: PrivateWorkspaceBrowserGrant,
      configuration: unknown,
      command: unknown,
      network?: PrivateLiveNetworkPreparation,
      participants?: PrivateLiveBrowserParticipants,
      initialStorageState?: unknown
    ): Promise<{
      engine: BrowserLifecycleEngine;
      opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
      binding: EgressBinding;
    }> {
      let resolveOpen!: (value: {
        engine: BrowserLifecycleEngine;
        opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
        binding: EgressBinding;
      }) => void;
      let rejectOpen!: (reason: unknown) => void;
      const work = retain(
        new Promise<{
          engine: BrowserLifecycleEngine;
          opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
          binding: EgressBinding;
        }>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        })
      );
      // Whole original admission exists before getters or participant callbacks can reenter stop.
      void (async () => {
        const grant = grants.get(capability);
        if (!grant || grant.used) throw new BrokerError('AUTHORITY_REFUSED');
        grant.used = true;
        facts(grant);
        if (
          network &&
          (typeof configuration !== 'object' ||
            configuration === null ||
            !('network' in configuration) ||
            typeof configuration.network !== 'object' ||
            configuration.network === null ||
            !('kind' in configuration.network) ||
            configuration.network.kind !== 'owned')
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        // Capture the original private participants after reserving the whole one-use admission.
        // A participant never replaces this authority's broker, policy, or receiver retention.
        const participantEngine = participants?.bindEngine?.bind(participants);
        if (runtimeOwner && !participantEngine) throw new BrokerError('AUTHORITY_REFUSED');
        const participantBirth = participants?.registerBirth.bind(participants);
        const participantRefusal = participants?.refuseBirth.bind(participants);
        const inputOriginal = participants?.input;
        const captureOriginal = participants?.capture;
        const inputRegister = inputOriginal?.registerDispatcher;
        const captureRegister = captureOriginal?.registerDispatcher;
        const participantInput =
          inputOriginal && typeof inputRegister === 'function'
            ? Object.freeze({
                registerDispatcher: inputRegister.bind(inputOriginal),
              })
            : undefined;
        const participantCapture =
          captureOriginal && typeof captureRegister === 'function'
            ? Object.freeze({
                registerDispatcher: captureRegister.bind(captureOriginal),
              })
            : undefined;
        const resourceOriginal = participants?.resources;
        const participantResources = resourceOriginal
          ? Object.freeze({
              onOriginalChild: resourceOriginal.onOriginalChild.bind(resourceOriginal),
            })
          : undefined;
        const navigationOriginal = participants?.navigation;
        const continuationOriginal = navigationOriginal?.continuation;
        const continuation = continuationOriginal
          ? Object.freeze({
              acquire: continuationOriginal.acquire.bind(continuationOriginal),
              joinPublications: continuationOriginal.joinPublications.bind(continuationOriginal),
              observeTransition: continuationOriginal.observeTransition?.bind(continuationOriginal),
            })
          : undefined;
        const observeLifetime = navigationOriginal?.observeLifetime?.bind(navigationOriginal);
        const participantNavigation = navigationOriginal
          ? Object.freeze({
              registerDispatcher: navigationOriginal.registerDispatcher.bind(navigationOriginal),
              ...(continuation ? { continuation } : {}),
              ...(observeLifetime ? { observeLifetime } : {}),
            })
          : undefined;
        if (
          runtimeOwner &&
          (!network || !participantInput || !participantCapture || !participantNavigation)
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        const uploadOriginal = participants?.upload;
        const downloadOriginal = participants?.download;
        const semanticOriginal = participants?.semantic;
        const uploadRegister = uploadOriginal?.registerDispatcher;
        const downloadRegister = downloadOriginal?.registerDispatcher;
        const semanticRegister = semanticOriginal?.registerDispatcher;
        if (
          (uploadOriginal && typeof uploadRegister !== 'function') ||
          (downloadOriginal && typeof downloadRegister !== 'function') ||
          (semanticOriginal && typeof semanticRegister !== 'function')
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        const participantUpload =
          uploadOriginal && uploadRegister
            ? Object.freeze({
                registerDispatcher: uploadRegister.bind(uploadOriginal),
              })
            : undefined;
        const participantDownload =
          downloadOriginal && downloadRegister
            ? Object.freeze({
                registerDispatcher: downloadRegister.bind(downloadOriginal),
              })
            : undefined;
        const participantSemantic =
          semanticOriginal && semanticRegister
            ? Object.freeze({
                registerDispatcher: semanticRegister.bind(semanticOriginal),
              })
            : undefined;
        const prepareNetwork = network?.prepare.bind(network);
        const activateNetwork = network?.activate.bind(network);
        facts(grant);
        let original: Original | undefined;
        let originalPeer: PrivateLiveNetworkPeer | undefined;
        let preparationStarted = false;
        let activationStarted = false;
        const owner: PrivateBrowserBirthOwner = Object.freeze({
          ...(participantInput ? { input: participantInput } : {}),
          ...(participantCapture ? { capture: participantCapture } : {}),
          ...(participantNavigation ? { navigation: participantNavigation } : {}),
          ...(participantResources ? { resources: participantResources } : {}),
          ...(participantUpload ? { upload: participantUpload } : {}),
          ...(participantDownload ? { download: participantDownload } : {}),
          ...(participantSemantic ? { semantic: participantSemantic } : {}),
          ...(network
            ? {
                network: Object.freeze({
                  async bindBeforeLaunch(receiver: PrivateBrowserRetirementReceiver) {
                    if (!original || original.receiver !== receiver || preparationStarted)
                      throw new BrokerError('AUTHORITY_REFUSED');
                    preparationStarted = true;
                    facts(grant);
                    const runtime = verifiedRuntime(original);
                    const peer = await retain(
                      prepareNetwork!(
                        Object.freeze({
                          receiver,
                          binding: Object.freeze({
                            ownerId: grant.ownerId,
                            workspaceId: grant.workspaceId,
                            browserId: receiver.browserId,
                            browserGeneration: receiver.browserGeneration,
                          }),
                          authorizationEpoch: grant.epoch,
                          runtimeIdentity: runtime.runtimeIdentity,
                          policyRevision: runtime.policyRevision,
                        })
                      )
                    );
                    originalPeer = peer; // Keep the exact acquired peer before checking fallible facts.
                    facts(grant);
                    if (!peer.isCustodyKnown()) throw new BrokerError('AUTHORITY_REFUSED');
                    return peer;
                  },
                  async activateReady(
                    receiver: PrivateBrowserRetirementReceiver,
                    peer: PrivateLiveNetworkPeer
                  ) {
                    if (
                      !original ||
                      original.receiver !== receiver ||
                      originalPeer !== peer ||
                      activationStarted
                    )
                      throw new BrokerError('AUTHORITY_REFUSED');
                    activationStarted = true;
                    verifiedRuntime(original);
                    facts(grant);
                    if (
                      original.ordinary?.() !== true ||
                      original.current?.() !== true ||
                      !peer.isCustodyKnown()
                    )
                      throw new BrokerError('AUTHORITY_REFUSED');
                    // The cold broker validates these fresh positive ports as part of activation;
                    // cold acceptance is still closed until its original activation completes.
                    original.active = true;
                    try {
                      await retain(activateNetwork!(receiver, peer));
                      facts(grant);
                      if (original.current?.() !== true || !peer.isCustodyKnown())
                        throw new BrokerError('AUTHORITY_REFUSED');
                    } catch (error) {
                      retire(original);
                      throw error;
                    }
                  },
                }),
              }
            : {}),
          registerBirth(receiver: PrivateBrowserRetirementReceiver) {
            if (original || originals.size >= 64 || originals.has(key(receiver)))
              throw new BrokerError('AUTHORITY_REFUSED');
            original = {
              receiver,
              grant,
              active: false,
              retirementStarted: false,
            };
            originals.set(key(receiver), original); // Original captured before any fallible reader.
            // Original receiver is retained first; capture each lifecycle callback before participant effects.
            original.ordinary = receiver.isOrdinary.bind(receiver);
            original.current = receiver.isAuthorityCurrent.bind(receiver);
            original.revoke = receiver.authorityRevoked;
            original.runtime = receiver.verifiedRuntimeBinding.bind(receiver);
            facts(grant);
            if (original.ordinary() !== true) throw new BrokerError('AUTHORITY_REFUSED');
            void receiver.observation.then(
              () => {
                original!.active = false;
              },
              () => {
                retire(original!);
              }
            );
            participantBirth?.(receiver);
            // The participant may reentrantly revoke the session/workspace or retire this original.
            facts(grant);
            if (original.ordinary?.() !== true) throw new BrokerError('AUTHORITY_REFUSED');
          },
          refuseBirth(receiver: PrivateBrowserRetirementReceiver) {
            if (original && original.receiver === receiver) retire(original);
            participantRefusal?.(receiver);
          },
        });
        let engine: BrowserLifecycleEngine | undefined;
        const acquiredOriginal: { engine?: BrowserLifecycleEngine } = {};
        try {
          if (initialStorageState !== undefined && !runtimeOwner)
            throw new BrokerError('AUTHORITY_REFUSED');
          let opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
          if (runtimeOwner) {
            const parsed = validateEngineConfiguration(configuration);
            const { runtime: _runtime, ...settings } = parsed;
            const acquired = await runtimeOwner.open(
              settings,
              Object.freeze({
                ...owner,
                bindEngine(actual: BrowserLifecycleEngine) {
                  acquiredOriginal.engine = actual; // Capture before genuine host binding can throw/reenter.
                  participantEngine?.(actual);
                  facts(grant);
                },
              }),
              command,
              undefined,
              _runtime.identity.mode,
              initialStorageState
            );
            if (acquiredOriginal.engine !== acquired.engine)
              throw new BrokerError('AUTHORITY_REFUSED');
            engine = acquired.engine;
            opened = acquired.opened;
          } else {
            engine = constructOwnedBrowserEngine(configuration, owner);
            participantEngine?.(engine);
            facts(grant);
            opened = await engine.open(command);
          }
          if (!engine) throw new BrokerError('AUTHORITY_REFUSED');
          if (!original || key(original.receiver) !== key(opened))
            throw new BrokerError('AUTHORITY_REFUSED');
          facts(grant);
          if (original.ordinary?.() !== true) throw new BrokerError('AUTHORITY_REFUSED');
          if (
            network &&
            (!activationStarted || !original.active || !originalPeer?.isCustodyKnown())
          )
            throw new BrokerError('AUTHORITY_REFUSED');
          if (!network) original.active = true;
          const binding = Object.freeze({
            ownerId: grant.ownerId,
            workspaceId: grant.workspaceId,
            browserId: original.receiver.browserId,
            browserGeneration: original.receiver.browserGeneration,
          });
          readCurrent(binding);
          return Object.freeze({ engine, opened, binding });
        } catch (error) {
          retainedFailure ??= Object.freeze({ value: error });
          if (original) retire(original);
          try {
            if (runtimeOwner) await retain(runtimeOwner.close());
            else await retain(engine!.shutdown());
          } catch {
            /* Retain original failure; original receiver custody remains held. */
          }
          throw error;
        }
      })().then(resolveOpen, (error) => {
        retainedFailure ??= Object.freeze({ value: error });
        rejectOpen(error);
      });
      return work;
    },
    authorizeBrowserAction(
      capability: PrivateWorkspaceBrowserGrant,
      binding: Pick<EgressBinding, 'browserId' | 'browserGeneration'>
    ) {
      const grant = grants.get(capability);
      const original = originals.get(key(binding));
      if (!grant || !grant.used || !original || original.grant !== grant)
        throw new BrokerError('AUTHORITY_REFUSED');
      return readCurrent({
        ...binding,
        ownerId: grant.ownerId,
        workspaceId: grant.workspaceId,
      });
    },
    authorizeOriginal(capability: PrivateWorkspaceBrowserGrant, binding: EgressBinding) {
      const grant = grants.get(capability);
      const original = originals.get(key(binding));
      if (!grant || !grant.used || !original || original.grant !== grant)
        throw new BrokerError('AUTHORITY_REFUSED');
      return readCurrent(binding);
    },
    revokeWorkspace(capability: PrivateWorkspaceBrowserGrant) {
      const grant = grants.get(capability);
      if (!grant) throw new BrokerError('AUTHORITY_REFUSED');
      grant.revoked = true;
      for (const original of originals.values()) if (original.grant === grant) retire(original);
    },
    /** Production disposal joins the original retained session/retirement work. The private legacy
     * stop remains synchronous; no timed-out original callback becomes acknowledged absence. */
    async stopAndJoin() {
      stopped = true;
      let failed = false,
        first: unknown;
      const fail = (reason: unknown) => {
        retainedFailure ??= Object.freeze({ value: reason });
        if (!failed) {
          failed = true;
          first = reason;
        }
      };
      if (retainedFailure) fail(retainedFailure.value);
      try {
        unsubscribe();
      } catch (error) {
        fail(error);
      }
      for (const original of originals.values()) {
        try {
          retire(original);
        } catch (error) {
          fail(error);
        }
      }
      while (retainedOperations.size) {
        const results = await Promise.allSettled([...retainedOperations]);
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
      }
      if (retainedFailure && !failed) fail(retainedFailure.value);
      if (failed) throw first;
    },
    stop() {
      stopped = true;
      unsubscribe();
      for (const original of originals.values()) retire(original);
    },
  });
}
