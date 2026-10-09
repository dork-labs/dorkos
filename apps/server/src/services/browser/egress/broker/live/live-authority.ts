import { createHash } from 'node:crypto';
import { session, workspaces, eq, type Db } from '@dorkos/db';
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
  sessionId: string;
  sessionDigest: string;
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
  verifiedRuntime?: Readonly<{ runtimeIdentity: string; policyRevision: number }>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authorityCurrent = (receiver: PrivateBrowserRetirementReceiver): boolean =>
  (
    receiver as PrivateBrowserRetirementReceiver & { isAuthorityCurrent?: () => boolean }
  ).isAuthorityCurrent?.() === true;

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
 * Private authenticated fixture composition only. This does not supply production
 * enable/readiness defaults. Current SQL facts are re-read at every forwarding fence.
 */
export function createLiveBrowserAuthority(options: {
  scope: 'private-fixture';
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
}) {
  if (
    options.scope !== 'private-fixture' ||
    !Number.isSafeInteger(options.policyRevision) ||
    options.policyRevision < 0
  )
    throw new BrokerError('UNAVAILABLE');
  const grants = new WeakMap<PrivateWorkspaceBrowserGrant, Grant>();
  const originals = new Map<string, Original>();
  const retainedOperations = new Set<Promise<unknown>>();
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
      () => retainedOperations.delete(original)
    );
    return original;
  };
  const retire = (original: Original) => {
    original.active = false;
    if (original.retirementStarted) return;
    original.retirementStarted = true;
    original.grant.revoked = true;
    try {
      retain(original.receiver.authorityRevoked());
    } catch {
      /* No retirement acknowledgment is invented. */
    }
  };
  const unsubscribe = options.config.onChange(() => {
    if (epoch === Number.MAX_SAFE_INTEGER) stopped = true;
    else epoch++;
    for (const original of originals.values()) retire(original);
  });
  const key = (value: Pick<EgressBinding, 'browserId' | 'browserGeneration'>) =>
    `${value.browserId}:${value.browserGeneration}`;
  const facts = (grant: Grant) => {
    if (
      stopped ||
      grant.revoked ||
      grant.epoch !== epoch ||
      options.config.get('auth').enabled !== true
    )
      throw new BrokerError('AUTHORITY_REFUSED');
    const owner = findOwnerAccount(options.db);
    const credential = options.db
      .select()
      .from(session)
      .where(eq(session.id, grant.sessionId))
      .get();
    const workspace = options.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, grant.workspaceId))
      .get();
    const utcNow = Date.now();
    if (
      owner?.id !== grant.ownerId ||
      !credential ||
      credential.userId !== grant.ownerId ||
      credential.expiresAt.getTime() <= utcNow ||
      digest(credential) !== grant.sessionDigest ||
      !workspace ||
      workspace.status !== 'ready' ||
      digest(workspace) !== grant.workspaceDigest
    )
      throw new BrokerError('AUTHORITY_REFUSED');
    return { utcNow, utcExpiresAt: credential.expiresAt.getTime() };
  };
  const verifiedRuntime = (original: Original) => {
    const proof = (
      original.receiver as PrivateBrowserRetirementReceiver & {
        verifiedRuntimeBinding?: () => Readonly<{
          runtimeIdentity: string;
          policyRevision: number;
        }> | null;
      }
    ).verifiedRuntimeBinding?.();
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
    try {
      if (
        !original ||
        !original.active ||
        binding.ownerId !== original.grant.ownerId ||
        binding.workspaceId !== original.grant.workspaceId ||
        !original.receiver.isOrdinary() ||
        !authorityCurrent(original.receiver)
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      options.checkOwnedOrigins?.(binding);
      const runtime = verifiedRuntime(original);
      const times = facts(original.grant);
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
        monotonicNow: now(),
        ...times,
      });
    } catch (error) {
      if (original) retire(original);
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
      // attempts consume this lifetime slot; a later settlement cannot erase custody.
      authorizationAttempts++;
      const enteredEpoch = epoch;
      // Original auth call remains retained if the bounded caller wait expires.
      const original = retain(
        options.auth.api.getSession({
          headers: fromNodeHeaders({ cookie: headers.cookie }),
          query: { disableCookieCache: true, disableRefresh: true },
        })
      );
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
      const capability = Object.freeze({ kind: 'private-workspace-browser-grant' as const });
      grants.set(capability, grant);
      return capability;
    },
    /** Called only by the private constructor composition, before its original engine birth. */
    async openEngine(
      capability: PrivateWorkspaceBrowserGrant,
      configuration: unknown,
      command: unknown,
      network?: PrivateLiveNetworkPreparation
    ): Promise<{
      engine: BrowserLifecycleEngine;
      opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>;
      binding: EgressBinding;
    }> {
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
      const grant = grants.get(capability);
      if (!grant || grant.used) throw new BrokerError('AUTHORITY_REFUSED');
      facts(grant);
      grant.used = true;
      let original: Original | undefined;
      let originalPeer: PrivateLiveNetworkPeer | undefined;
      let preparationStarted = false;
      let activationStarted = false;
      const owner: PrivateBrowserBirthOwner = Object.freeze({
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
                    network.prepare(
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
                    !receiver.isOrdinary() ||
                    !authorityCurrent(receiver) ||
                    !peer.isCustodyKnown()
                  )
                    throw new BrokerError('AUTHORITY_REFUSED');
                  // The cold broker validates these fresh positive ports as part of activation;
                  // cold acceptance is still closed until its original activation completes.
                  original.active = true;
                  try {
                    await retain(network.activate(receiver, peer));
                    facts(grant);
                    if (!authorityCurrent(receiver) || !peer.isCustodyKnown())
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
          original = { receiver, grant, active: false, retirementStarted: false };
          originals.set(key(receiver), original); // Original captured before any fallible reader.
          facts(grant);
          if (!receiver.isOrdinary()) throw new BrokerError('AUTHORITY_REFUSED');
          void receiver.observation.then(
            () => {
              original!.active = false;
            },
            () => {
              retire(original!);
            }
          );
        },
        refuseBirth(receiver: PrivateBrowserRetirementReceiver) {
          if (original && original.receiver === receiver) retire(original);
        },
      });
      const engine = constructOwnedBrowserEngine(configuration, owner);
      try {
        const opened = await engine.open(command);
        if (!original || key(original.receiver) !== key(opened))
          throw new BrokerError('AUTHORITY_REFUSED');
        facts(grant);
        if (!original.receiver.isOrdinary()) throw new BrokerError('AUTHORITY_REFUSED');
        if (network && (!activationStarted || !original.active || !originalPeer?.isCustodyKnown()))
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
        if (original) retire(original);
        try {
          await retain(engine.shutdown());
        } catch {
          /* Retain original failure; original receiver custody remains held. */
        }
        throw error;
      }
    },
    authorizeBrowserAction(
      capability: PrivateWorkspaceBrowserGrant,
      binding: Pick<EgressBinding, 'browserId' | 'browserGeneration'>
    ) {
      const grant = grants.get(capability);
      const original = originals.get(key(binding));
      if (!grant || !grant.used || !original || original.grant !== grant)
        throw new BrokerError('AUTHORITY_REFUSED');
      return readCurrent({ ...binding, ownerId: grant.ownerId, workspaceId: grant.workspaceId });
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
    stop() {
      stopped = true;
      unsubscribe();
      for (const original of originals.values()) retire(original);
    },
  });
}
