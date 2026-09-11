/**
 * Owner-bound hosted managed account authentication flow.
 *
 * @module lib/connectors/managed/authentication-service
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ComposioManagedAccountError,
  ComposioAuthenticationSetupError,
  type ComposioManagedAccountClient,
} from '@dorkos/connector-providers/composio';
import {
  ManagedConnectorAuthenticationCreateRequestSchema,
  ManagedConnectorAuthenticationStateSchema,
  type ManagedConnectorAuthenticationState,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm';

import { schema } from '@/db/client';
import type { ManagedConnectorConfig } from './config';
import { managedCapabilityAvailability } from './config';
import { HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID } from './request-context';
import {
  managedRequestHash,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
} from './authority-service';
import { managedAccountFromRow } from './discovery-service';
import {
  ManagedAuthenticationResolutionError,
  type ManagedResolvedAuthentication,
} from './auth-config-resolver';

const FLOW_LIFETIME_MS = 10 * 60 * 1_000;
/** Allows the 30s resolver cap followed by at most 15s of account-link I/O. */
export const MANAGED_AUTHENTICATION_START_TIMEOUT_MS = 45_000;
/** Single browser cookie intentionally allows one active callback flow at a time. */
export const MANAGED_CONNECTOR_FLOW_COOKIE = 'dorkos_managed_connector_flow';

type ManagedAccountStartClient = Pick<ComposioManagedAccountClient, 'createLink'>;
type ManagedAccountCompletionClient = Pick<
  ComposioManagedAccountClient,
  'completeAuth' | 'getAccount'
>;
type ManagedAccountReadClient = Pick<ComposioManagedAccountClient, 'getAccount'>;

/** Safe flow conflict or unavailable classification. */
export class ManagedAuthenticationFlowError extends Error {
  readonly code: 'conflict' | 'unavailable' | 'not_found' | 'forbidden' | 'expired';

  constructor(code: ManagedAuthenticationFlowError['code'], message: string) {
    super(message);
    this.name = 'ManagedAuthenticationFlowError';
    this.code = code;
  }
}

function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHash(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaque(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function browserNonce(projectApiKey: string, flowId: string): string {
  return createHmac('sha256', projectApiKey).update(`managed-flow:${flowId}`).digest('base64url');
}

function logAuthenticationStartFailure(input: {
  stage: 'resolve_authentication';
  error: unknown;
  startedAt: number;
  signal: AbortSignal;
}): void {
  const diagnostic =
    input.error instanceof ManagedAuthenticationResolutionError
      ? {
          category: 'authentication_resolution',
          resolutionReason: ManagedAuthenticationResolutionError.safeReason(input.error),
        }
      : input.error instanceof ComposioManagedAccountError
        ? {
            category: 'provider_request',
            code: input.error.code,
            status: input.error.status,
          }
        : input.error instanceof ComposioAuthenticationSetupError
          ? {
              category: 'authentication_setup',
              setupReason: input.error.reason,
              ...(input.error.metadataIssueCount === undefined
                ? {}
                : {
                    setupMetadataIssueCount: input.error.metadataIssueCount,
                    setupMetadataIssueLocations: input.error.metadataIssueLocations,
                    setupMetadataMethodKinds: input.error.metadataMethodKinds,
                  }),
            }
          : input.signal.aborted
            ? { category: 'deadline_exceeded' }
            : { category: 'unknown' };
  console.warn('[Managed connectors] Authentication start did not complete', {
    stage: input.stage,
    ...diagnostic,
    elapsedMs: Math.max(0, Date.now() - input.startedAt),
  });
}

/** Persist only an exact verified account while rechecking live instance and provider authority. */
export async function persistVerifiedManagedConnection(input: {
  db: ManagedConnectorDatabase;
  flow: typeof schema.managedConnectorAuthFlow.$inferSelect;
  account: Awaited<ReturnType<ManagedAccountReadClient['getAccount']>>;
  executionConfigDigest: string;
  expectedFlowState: 'consumed' | 'reconcile';
}): Promise<string> {
  const { account, flow } = input;
  if (
    account.connectedAccountId !== flow.provisionalExternalAccountRef ||
    account.providerUserId !== flow.providerUserId ||
    account.toolkit !== flow.toolkit ||
    account.authConfigId !== flow.authConfigId ||
    account.status !== 'ACTIVE'
  ) {
    throw new ManagedAuthenticationFlowError('forbidden', 'Provider account did not match.');
  }
  return input.db.transaction(async (tx) => {
    const [liveInstance] = await tx
      .select({ id: schema.instance.id })
      .from(schema.instance)
      .where(
        and(
          eq(schema.instance.id, flow.instanceId),
          eq(schema.instance.userId, flow.ownerUserId),
          isNull(schema.instance.revokedAt)
        )
      )
      .for('update');
    if (!liveInstance) {
      throw new ManagedAuthenticationFlowError('forbidden', 'Linked instance is unavailable.');
    }
    const [provider] = await tx
      .select()
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, flow.tenantId),
          eq(schema.managedConnectorProvider.id, flow.providerInstanceId),
          eq(schema.managedConnectorProvider.enabled, true),
          eq(schema.managedConnectorProvider.materialGeneration, flow.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, input.executionConfigDigest)
        )
      )
      .limit(1);
    if (!provider) throw new ManagedAuthenticationFlowError('forbidden', 'Provider changed.');
    const [existing] = await tx
      .select()
      .from(schema.managedConnectorConnection)
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, flow.tenantId),
          eq(schema.managedConnectorConnection.providerInstanceId, flow.providerInstanceId),
          eq(schema.managedConnectorConnection.externalAccountRef, account.connectedAccountId)
        )
      )
      .limit(1)
      .for('update');
    let connectionId: string;
    if (existing) {
      if (
        existing.originatingInstanceId !== flow.instanceId ||
        existing.providerUserId !== flow.providerUserId ||
        existing.toolkit !== flow.toolkit ||
        existing.authConfigId !== flow.authConfigId
      ) {
        throw new ManagedAuthenticationFlowError('forbidden', 'Provider account did not match.');
      }
      connectionId = existing.id;
      await tx
        .update(schema.managedConnectorConnection)
        .set({
          authenticationStatus: 'active',
          lifecycle: 'active',
          materialGeneration: provider.materialGeneration,
          bindingGeneration: sql`${schema.managedConnectorConnection.bindingGeneration} + 1`,
          label: flow.requestedLabel ?? existing.label,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.managedConnectorConnection.tenantId, flow.tenantId),
            eq(schema.managedConnectorConnection.id, existing.id),
            eq(schema.managedConnectorConnection.originatingInstanceId, flow.instanceId)
          )
        );
    } else {
      connectionId = `managed-${randomUUID()}`;
      await tx.insert(schema.managedConnectorConnection).values({
        tenantId: flow.tenantId,
        id: connectionId,
        originatingInstanceId: flow.instanceId,
        providerInstanceId: flow.providerInstanceId,
        providerUserId: flow.providerUserId,
        externalAccountRef: account.connectedAccountId,
        toolkit: flow.toolkit,
        authConfigId: flow.authConfigId,
        label: flow.requestedLabel ?? flow.toolkit,
        lifecycle: 'active',
        authenticationStatus: 'active',
        materialGeneration: provider.materialGeneration,
      });
    }
    const [connected] = await tx
      .update(schema.managedConnectorAuthFlow)
      .set({ state: 'connected', connectionId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
          eq(schema.managedConnectorAuthFlow.id, flow.id),
          eq(schema.managedConnectorAuthFlow.state, input.expectedFlowState)
        )
      )
      .returning({ id: schema.managedConnectorAuthFlow.id });
    if (!connected) throw new ManagedAuthenticationFlowError('conflict', 'Flow state changed.');
    return connectionId;
  });
}

async function flowState(
  db: ManagedConnectorDatabase,
  row: typeof schema.managedConnectorAuthFlow.$inferSelect,
  callbackOrigin: string | undefined,
  projectApiKey: string | undefined
): Promise<ManagedConnectorAuthenticationState> {
  const base = {
    version: 1 as const,
    flowId: row.id,
    toolkit: row.toolkit,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
  if (row.state === 'starting') {
    return ManagedConnectorAuthenticationStateSchema.parse({ ...base, state: 'starting' });
  }
  if (row.state === 'start_unknown') {
    return ManagedConnectorAuthenticationStateSchema.parse({
      ...base,
      state: 'start_unknown',
      reason: 'The provider may have started sign-in, but did not confirm it.',
      completedAt: row.updatedAt.toISOString(),
    });
  }
  if (row.state === 'connected') {
    if (!row.connectionId) {
      return ManagedConnectorAuthenticationStateSchema.parse({
        ...base,
        state: 'failed',
        reason: 'The connected account is no longer available.',
        completedAt: row.updatedAt.toISOString(),
      });
    }
    const [connection] = await db
      .select()
      .from(schema.managedConnectorConnection)
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, row.tenantId),
          eq(schema.managedConnectorConnection.originatingInstanceId, row.instanceId),
          eq(schema.managedConnectorConnection.id, row.connectionId)
        )
      )
      .limit(1);
    if (connection) {
      return ManagedConnectorAuthenticationStateSchema.parse({
        ...base,
        state: 'connected',
        account: managedAccountFromRow(connection),
        completedAt: row.updatedAt.toISOString(),
      });
    }
    return ManagedConnectorAuthenticationStateSchema.parse({
      ...base,
      state: 'failed',
      reason: 'The connected account is no longer available.',
      completedAt: row.updatedAt.toISOString(),
    });
  }
  if (row.state === 'failed' || row.state === 'reconcile') {
    return ManagedConnectorAuthenticationStateSchema.parse({
      ...base,
      state: 'failed',
      reason:
        row.state === 'reconcile'
          ? 'Sign-in needs account reconciliation before it can be used.'
          : 'The provider could not complete account sign-in.',
      completedAt: row.updatedAt.toISOString(),
    });
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return ManagedConnectorAuthenticationStateSchema.parse({
      ...base,
      state: 'expired',
      completedAt: row.updatedAt.toISOString(),
    });
  }
  return ManagedConnectorAuthenticationStateSchema.parse({
    ...base,
    state: 'pending',
    ...(row.state === 'waiting' &&
    callbackOrigin &&
    projectApiKey &&
    safeEqualHash(browserNonce(projectApiKey, row.id), row.browserNonceHash)
      ? {
          authorizeUrl: `${callbackOrigin}/connectors/managed/authorize?flow=${encodeURIComponent(row.id)}&nonce=${encodeURIComponent(browserNonce(projectApiKey, row.id))}`,
        }
      : {}),
  });
}

/** Claim and start one provider authentication flow without replaying an ambiguous create. */
export async function startManagedAuthentication(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  providerUserId: string;
  materialGeneration: number;
  executionConfigDigest: string;
  accounts: ManagedAccountStartClient;
  resolveAuthentication: (
    toolkit: string,
    signal: AbortSignal
  ) => Promise<ManagedResolvedAuthentication>;
  config: ManagedConnectorConfig;
  rawRequest: unknown;
  verifyLiveInstance: () => Promise<boolean>;
  signal: AbortSignal;
  startTimeoutMs?: number;
}): Promise<ManagedConnectorAuthenticationState> {
  const startedAt = Date.now();
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.startTimeoutMs ?? MANAGED_AUTHENTICATION_START_TIMEOUT_MS),
  ]);
  signal.throwIfAborted();
  const request = ManagedConnectorAuthenticationCreateRequestSchema.parse(input.rawRequest);
  const available = managedCapabilityAvailability(input.config, 'authentication', request.toolkit);
  if (available.status === 'unavailable') {
    throw new ManagedAuthenticationFlowError('unavailable', available.reason);
  }
  const requestHash = managedRequestHash(request);
  const [replay] = await input.db
    .select()
    .from(schema.managedConnectorAuthFlow)
    .where(
      and(
        eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorAuthFlow.instanceId, input.principal.instanceId),
        eq(schema.managedConnectorAuthFlow.idempotencyKey, request.requestId)
      )
    )
    .limit(1);
  if (replay) {
    if (replay.requestHash !== requestHash)
      throw new ManagedAuthenticationFlowError('conflict', 'Authentication request conflicts.');
    return flowState(input.db, replay, input.config.callbackOrigin!, input.config.projectApiKey!);
  }
  if (!(await input.verifyLiveInstance()))
    throw new ManagedAuthenticationFlowError('forbidden', 'Linked instance is unavailable.');
  let resolved: ManagedResolvedAuthentication;
  try {
    resolved = await input.resolveAuthentication(request.toolkit, signal);
    signal.throwIfAborted();
  } catch (error) {
    logAuthenticationStartFailure({
      stage: 'resolve_authentication',
      error,
      startedAt,
      signal,
    });
    throw new ManagedAuthenticationFlowError(
      'unavailable',
      error instanceof ComposioAuthenticationSetupError
        ? error.message
        : 'Account setup could not be confirmed. Check this service’s setup before trying again.'
    );
  }
  const flowId = randomUUID();
  const nonce = browserNonce(input.config.projectApiKey!, flowId);
  const expiresAt = new Date(Date.now() + FLOW_LIFETIME_MS);
  const [claimed] = await input.db
    .insert(schema.managedConnectorAuthFlow)
    .values({
      tenantId: input.principal.tenantId,
      id: flowId,
      ownerUserId: input.principal.ownerId,
      instanceId: input.principal.instanceId,
      providerInstanceId: HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID,
      materialGeneration: input.materialGeneration,
      providerUserId: input.providerUserId,
      toolkit: request.toolkit,
      requestedLabel: request.label ?? null,
      authConfigId: resolved.authConfigId,
      completionKind: resolved.descriptor.kind,
      authenticationDescriptor: resolved.descriptor,
      authenticationDescriptorDigest: resolved.descriptorDigest,
      idempotencyKey: request.requestId,
      requestHash,
      browserNonceHash: hashOpaque(nonce),
      state: 'starting',
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!claimed) {
    const [existing] = await input.db
      .select()
      .from(schema.managedConnectorAuthFlow)
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorAuthFlow.instanceId, input.principal.instanceId),
          eq(schema.managedConnectorAuthFlow.idempotencyKey, request.requestId)
        )
      )
      .limit(1);
    if (!existing || existing.requestHash !== requestHash) {
      throw new ManagedAuthenticationFlowError('conflict', 'Authentication request conflicts.');
    }
    return flowState(input.db, existing, input.config.callbackOrigin!, input.config.projectApiKey!);
  }

  try {
    if (!(await input.verifyLiveInstance())) {
      await input.db
        .update(schema.managedConnectorAuthFlow)
        .set({ state: 'failed', updatedAt: new Date() })
        .where(
          and(
            eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
            eq(schema.managedConnectorAuthFlow.id, flowId),
            eq(schema.managedConnectorAuthFlow.state, 'starting')
          )
        );
      throw new ManagedAuthenticationFlowError('forbidden', 'Linked instance is unavailable.');
    }
    signal.throwIfAborted();
    const link =
      resolved.descriptor.kind === 'oauth'
        ? await input.accounts.createLink({
            providerUserId: input.providerUserId,
            authConfigId: resolved.authConfigId,
            signal,
          })
        : null;
    const [waiting] = await input.db
      .update(schema.managedConnectorAuthFlow)
      .set({
        state: 'waiting',
        provisionalExternalAccountRef: link?.connectedAccountId ?? null,
        upstreamAuthorizeUrl: link?.redirectUrl ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorAuthFlow.id, flowId),
          eq(schema.managedConnectorAuthFlow.state, 'starting'),
          exists(
            input.db
              .select({ id: schema.managedConnectorProvider.id })
              .from(schema.managedConnectorProvider)
              .where(
                and(
                  eq(schema.managedConnectorProvider.tenantId, input.principal.tenantId),
                  eq(schema.managedConnectorProvider.id, HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID),
                  eq(schema.managedConnectorProvider.enabled, true),
                  eq(schema.managedConnectorProvider.materialGeneration, input.materialGeneration),
                  eq(
                    schema.managedConnectorProvider.configurationDigest,
                    input.executionConfigDigest
                  )
                )
              )
          )
        )
      )
      .returning();
    if (!waiting) {
      await input.db
        .update(schema.managedConnectorAuthFlow)
        .set({ state: 'start_unknown', updatedAt: new Date() })
        .where(
          and(
            eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
            eq(schema.managedConnectorAuthFlow.id, flowId),
            eq(schema.managedConnectorAuthFlow.state, 'starting')
          )
        );
      throw new ManagedAuthenticationFlowError('conflict', 'Flow state changed.');
    }
    const authorizeUrl = new URL(
      `/connectors/managed/authorize?flow=${encodeURIComponent(flowId)}`,
      input.config.callbackOrigin
    );
    authorizeUrl.searchParams.set('nonce', nonce);
    return ManagedConnectorAuthenticationStateSchema.parse({
      version: 1,
      flowId,
      toolkit: request.toolkit,
      createdAt: waiting.createdAt.toISOString(),
      expiresAt: waiting.expiresAt.toISOString(),
      state: 'pending',
      authorizeUrl: authorizeUrl.toString(),
    });
  } catch (error) {
    if (error instanceof ManagedAuthenticationFlowError) throw error;
    const knownCancelled =
      error instanceof ComposioManagedAccountError && error.code === 'cancelled';
    await input.db
      .update(schema.managedConnectorAuthFlow)
      .set({ state: knownCancelled ? 'failed' : 'start_unknown', updatedAt: new Date() })
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorAuthFlow.id, flowId),
          eq(schema.managedConnectorAuthFlow.state, 'starting')
        )
      );
    const [unknown] = await input.db
      .select()
      .from(schema.managedConnectorAuthFlow)
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorAuthFlow.id, flowId)
        )
      );
    return flowState(input.db, unknown, input.config.callbackOrigin!, input.config.projectApiKey!);
  }
}

/** Read one linked-instance-owned hosted flow. */
export async function getManagedAuthenticationState(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  flowId: string;
  callbackOrigin?: string;
  projectApiKey?: string;
}): Promise<ManagedConnectorAuthenticationState | null> {
  const [row] = await input.db
    .select()
    .from(schema.managedConnectorAuthFlow)
    .where(
      and(
        eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorAuthFlow.instanceId, input.principal.instanceId),
        eq(schema.managedConnectorAuthFlow.id, input.flowId)
      )
    )
    .limit(1);
  return row ? flowState(input.db, row, input.callbackOrigin, input.projectApiKey) : null;
}

/** Recover an ambiguously completed flow from the exact provider account without redeeming again. */
export async function reconcileManagedAuthentication(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  providerUserId: string;
  materialGeneration: number;
  executionConfigDigest: string;
  accounts: ManagedAccountReadClient;
  flowId: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const [flow] = await input.db
    .select()
    .from(schema.managedConnectorAuthFlow)
    .where(
      and(
        eq(schema.managedConnectorAuthFlow.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorAuthFlow.instanceId, input.principal.instanceId),
        eq(schema.managedConnectorAuthFlow.ownerUserId, input.principal.ownerId),
        eq(schema.managedConnectorAuthFlow.id, input.flowId),
        eq(schema.managedConnectorAuthFlow.state, 'reconcile')
      )
    )
    .limit(1);
  if (
    !flow?.provisionalExternalAccountRef ||
    flow.providerUserId !== input.providerUserId ||
    flow.materialGeneration !== input.materialGeneration
  ) {
    return false;
  }
  let account: Awaited<ReturnType<ManagedAccountReadClient['getAccount']>>;
  try {
    account = await input.accounts.getAccount(flow.provisionalExternalAccountRef, input.signal);
  } catch {
    return false;
  }
  try {
    await persistVerifiedManagedConnection({
      db: input.db,
      flow,
      account,
      executionConfigDigest: input.executionConfigDigest,
      expectedFlowState: 'reconcile',
    });
    return true;
  } catch (error) {
    if (error instanceof ManagedAuthenticationFlowError) return false;
    throw error;
  }
}

/** Bind one signed-in owner's browser to the upstream redirect. */
export async function bindManagedAuthenticationBrowser(input: {
  db: ManagedConnectorDatabase;
  ownerId: string;
  flowId: string;
  nonce: string;
}): Promise<{ redirectUrl: string; cookieValue: string } | null> {
  const [flow] = await input.db
    .select()
    .from(schema.managedConnectorAuthFlow)
    .where(
      and(
        eq(schema.managedConnectorAuthFlow.id, input.flowId),
        eq(schema.managedConnectorAuthFlow.ownerUserId, input.ownerId),
        eq(schema.managedConnectorAuthFlow.state, 'waiting'),
        eq(schema.managedConnectorAuthFlow.completionKind, 'oauth'),
        isNull(schema.managedConnectorAuthFlow.browserBoundAt),
        gt(schema.managedConnectorAuthFlow.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!flow?.upstreamAuthorizeUrl || !safeEqualHash(input.nonce, flow.browserNonceHash))
    return null;
  // The URL nonce proves this handoff, not possession of the winning browser.
  // Only its HttpOnly cookie receives this independent completion secret.
  const completionSecret = randomBytes(32).toString('base64url');
  const [claimed] = await input.db
    .update(schema.managedConnectorAuthFlow)
    .set({
      browserBoundAt: new Date(),
      browserCompletionHash: hashOpaque(completionSecret),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
        eq(schema.managedConnectorAuthFlow.id, flow.id),
        eq(schema.managedConnectorAuthFlow.state, 'waiting'),
        eq(schema.managedConnectorAuthFlow.completionKind, 'oauth'),
        isNull(schema.managedConnectorAuthFlow.browserBoundAt),
        gt(schema.managedConnectorAuthFlow.expiresAt, new Date())
      )
    )
    .returning();
  if (!claimed) return null;
  return { redirectUrl: flow.upstreamAuthorizeUrl, cookieValue: `${flow.id}.${completionSecret}` };
}

/** Consume one owner-bound callback before redeeming its opaque provider session. */
export async function completeManagedAuthentication(input: {
  db: ManagedConnectorDatabase;
  ownerId: string;
  cookieValue: string;
  sessionUri: string;
  createAccounts: (providerUserId: string) => {
    accounts: ManagedAccountCompletionClient;
    executionConfigDigest: string;
  };
  signal: AbortSignal;
}): Promise<{ connectionId: string }> {
  const split = input.cookieValue.indexOf('.');
  if (split < 1) throw new ManagedAuthenticationFlowError('forbidden', 'Flow cookie is invalid.');
  const flowId = input.cookieValue.slice(0, split);
  const nonce = input.cookieValue.slice(split + 1);
  const now = new Date();
  const [flow] = await input.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.managedConnectorAuthFlow)
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.id, flowId),
          eq(schema.managedConnectorAuthFlow.ownerUserId, input.ownerId),
          eq(schema.managedConnectorAuthFlow.state, 'waiting'),
          eq(schema.managedConnectorAuthFlow.completionKind, 'oauth'),
          gt(schema.managedConnectorAuthFlow.expiresAt, now)
        )
      )
      .limit(1);
    if (
      !current?.browserBoundAt ||
      !current.browserCompletionHash ||
      !safeEqualHash(nonce, current.browserCompletionHash)
    )
      return [];
    return tx
      .update(schema.managedConnectorAuthFlow)
      .set({
        state: 'consumed',
        consumedAt: now,
        completionSessionHash: hashOpaque(input.sessionUri),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, current.tenantId),
          eq(schema.managedConnectorAuthFlow.id, current.id),
          eq(schema.managedConnectorAuthFlow.state, 'waiting')
        )
      )
      .returning();
  });
  if (!flow) throw new ManagedAuthenticationFlowError('forbidden', 'Flow is unavailable.');

  try {
    const material = input.createAccounts(flow.providerUserId);
    const [providerBeforeCompletion] = await input.db
      .select()
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, flow.tenantId),
          eq(schema.managedConnectorProvider.id, flow.providerInstanceId),
          eq(schema.managedConnectorProvider.enabled, true),
          eq(schema.managedConnectorProvider.materialGeneration, flow.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, material.executionConfigDigest)
        )
      )
      .limit(1);
    if (!providerBeforeCompletion) {
      throw new ManagedAuthenticationFlowError('forbidden', 'Provider changed.');
    }
    const completed = await material.accounts.completeAuth({
      sessionUri: input.sessionUri,
      providerUserId: flow.providerUserId,
      signal: input.signal,
    });
    if (
      completed.connectedAccountId !== flow.provisionalExternalAccountRef ||
      completed.toolkit !== flow.toolkit
    ) {
      throw new ManagedAuthenticationFlowError('forbidden', 'Provider account did not match.');
    }
    const account = await material.accounts.getAccount(completed.connectedAccountId, input.signal);
    const connectionId = await persistVerifiedManagedConnection({
      db: input.db,
      flow,
      account,
      executionConfigDigest: material.executionConfigDigest,
      expectedFlowState: 'consumed',
    });
    return { connectionId };
  } catch (error) {
    await input.db
      .update(schema.managedConnectorAuthFlow)
      .set({
        state:
          error instanceof ManagedAuthenticationFlowError ||
          (error instanceof ComposioManagedAccountError &&
            error.code !== 'outcome_unknown' &&
            error.status !== undefined &&
            error.status < 500)
            ? 'failed'
            : 'reconcile',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
          eq(schema.managedConnectorAuthFlow.id, flow.id),
          eq(schema.managedConnectorAuthFlow.state, 'consumed')
        )
      );
    if (error instanceof ManagedAuthenticationFlowError) throw error;
    throw new ManagedAuthenticationFlowError(
      'unavailable',
      'Provider completion needs reconciliation.'
    );
  }
}
