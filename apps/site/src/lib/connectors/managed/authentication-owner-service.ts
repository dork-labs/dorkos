/** Signed-in hosted owner boundary for credential fields and explicit no-auth confirmation. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ComposioAuthenticationDescriptorSchema,
  ComposioManagedAccountError,
  createComposioHostedClients,
  matchesComposioAutomaticAuthenticationPolicy,
  selectComposioAuthentication,
  validateComposioAuthenticationFields,
  type ComposioManagedAccountClient,
} from '@dorkos/connector-providers/composio';
import { schema } from '@/db/client';
import type { ManagedConnectorDatabase } from './authority-service';
import {
  bindManagedAuthenticationBrowser,
  ManagedAuthenticationFlowError,
  persistVerifiedManagedConnection,
} from './authentication-service';
import {
  managedCapabilityAvailability,
  readManagedConnectorConfig,
  type ManagedConnectorConfig,
} from './config';
import { managedAuthenticationDescriptorDigest } from './auth-config-resolver';
import type {
  ManagedAuthenticationFieldsPage,
  ManagedAuthenticationOwnerService,
} from './authentication-owner-contract';

type Flow = typeof schema.managedConnectorAuthFlow.$inferSelect;
type Accounts = Pick<
  ComposioManagedAccountClient,
  | 'getToolkitAuthentication'
  | 'getAuthenticationConfiguration'
  | 'createFieldAccount'
  | 'getAccount'
>;
type Material = { accounts: Accounts; executionConfigDigest: string };

/** Internal dependency seams for exact synthetic tests; production uses configured project custody. */
export interface ManagedAuthenticationOwnerDependencies {
  readConfig?: () => ManagedConnectorConfig;
  createAccounts?: (providerUserId: string, config: ManagedConnectorConfig) => Material;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function equalHash(value: string, expected: string): boolean {
  const actual = Buffer.from(hash(value));
  const other = Buffer.from(expected);
  return actual.length === other.length && timingSafeEqual(actual, other);
}
function refuse(): never {
  throw new ManagedAuthenticationFlowError(
    'forbidden',
    'This account setup is no longer available.'
  );
}
function cookieParts(value: string): { flowId: string; secret: string } | null {
  if (value.length > 128) return null;
  const [flowId, secret, extra] = value.split('.');
  return !extra &&
    z.string().uuid().safeParse(flowId).success &&
    /^[A-Za-z0-9_-]{43}$/.test(secret ?? '')
    ? { flowId, secret }
    : null;
}
function descriptor(flow: Flow) {
  const parsed = ComposioAuthenticationDescriptorSchema.safeParse(flow.authenticationDescriptor);
  if (
    !parsed.success ||
    parsed.data.kind === 'oauth' ||
    parsed.data.kind !== flow.completionKind ||
    parsed.data.toolkit !== flow.toolkit ||
    managedAuthenticationDescriptorDigest(parsed.data) !== flow.authenticationDescriptorDigest
  )
    return refuse();
  return parsed.data;
}
function csrf(flow: Flow, secret: string): string {
  return createHmac('sha256', secret).update(`managed-fields:${flow.id}`).digest('base64url');
}
function page(flow: Flow, secret: string): ManagedAuthenticationFieldsPage {
  const selected = descriptor(flow);
  return {
    kind: selected.kind as 'fields' | 'none',
    descriptor: selected,
    descriptorDigest: flow.authenticationDescriptorDigest!,
    csrfToken: csrf(flow, secret),
  };
}

/** Create the hosted owner service without exposing project credentials to page props or local transport. */
export function createManagedAuthenticationOwnerService(
  db: ManagedConnectorDatabase,
  dependencies: ManagedAuthenticationOwnerDependencies = {}
): ManagedAuthenticationOwnerService {
  function configuration(): ManagedConnectorConfig {
    const config = (dependencies.readConfig ?? readManagedConnectorConfig)();
    if (
      managedCapabilityAvailability(config, 'catalog').status !== 'available' ||
      !config.projectApiKey ||
      !config.callbackOrigin
    )
      return refuse();
    return config;
  }
  function material(flow: Flow, config: ManagedConnectorConfig): Material {
    return (
      dependencies.createAccounts?.(flow.providerUserId, config) ??
      createComposioHostedClients({
        apiKey: config.projectApiKey!,
        serverUserId: flow.providerUserId,
        authConfigByToolkit: config.authConfigByToolkit,
        ...(config.apiOrigin ? { baseUrl: config.apiOrigin } : {}),
      })
    );
  }
  async function waiting(ownerId: string, flowId: string): Promise<Flow | undefined> {
    if (!z.string().uuid().safeParse(flowId).success) return undefined;
    const [flow] = await db
      .select()
      .from(schema.managedConnectorAuthFlow)
      .where(
        and(
          eq(schema.managedConnectorAuthFlow.id, flowId),
          eq(schema.managedConnectorAuthFlow.ownerUserId, ownerId),
          eq(schema.managedConnectorAuthFlow.state, 'waiting'),
          gt(schema.managedConnectorAuthFlow.expiresAt, new Date())
        )
      )
      .limit(1);
    return flow;
  }
  async function authority(flow: Flow, executionConfigDigest: string): Promise<boolean> {
    const [instance] = await db
      .select({ id: schema.instance.id })
      .from(schema.instance)
      .where(
        and(
          eq(schema.instance.id, flow.instanceId),
          eq(schema.instance.userId, flow.ownerUserId),
          isNull(schema.instance.revokedAt)
        )
      )
      .limit(1);
    if (!instance) return false;
    const [provider] = await db
      .select({ id: schema.managedConnectorProvider.id })
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, flow.tenantId),
          eq(schema.managedConnectorProvider.id, flow.providerInstanceId),
          eq(schema.managedConnectorProvider.enabled, true),
          eq(schema.managedConnectorProvider.materialGeneration, flow.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, executionConfigDigest)
        )
      )
      .limit(1);
    return Boolean(provider);
  }
  async function freshDescriptor(flow: Flow, accounts: Accounts, signal: AbortSignal) {
    const selected = descriptor(flow);
    const config = await accounts.getAuthenticationConfiguration(flow.authConfigId, signal);
    if (
      (selected.source === 'account-fields' && config.managed) ||
      config.id !== flow.authConfigId ||
      config.toolkit !== flow.toolkit ||
      !config.enabled ||
      config.scheme !== selected.scheme
    )
      return refuse();
    const toolkit = await accounts.getToolkitAuthentication(flow.toolkit, signal);
    if (
      selected.source !== 'configured' &&
      !matchesComposioAutomaticAuthenticationPolicy(config, toolkit, selected)
    )
      return refuse();
    // Revalidate this flow's captured configuration, never replace it with today's default selection.
    const current = { ...selectComposioAuthentication(toolkit, config), source: selected.source };
    if (managedAuthenticationDescriptorDigest(current) !== flow.authenticationDescriptorDigest)
      return refuse();
    return selected;
  }
  return {
    async authorize(input) {
      input.signal.throwIfAborted();
      const flow = await waiting(input.ownerId, input.flowId);
      if (!flow || flow.browserBoundAt || !equalHash(input.nonce, flow.browserNonceHash))
        return null;
      const config = configuration();
      const boundMaterial = material(flow, config);
      if (!(await authority(flow, boundMaterial.executionConfigDigest))) return null;
      const remainingSeconds = () =>
        Math.min(600, Math.floor((flow.expiresAt.getTime() - Date.now()) / 1000));
      if (remainingSeconds() <= 0) return null;
      if (flow.completionKind === 'oauth') {
        const bound = await bindManagedAuthenticationBrowser({
          db,
          ownerId: input.ownerId,
          flowId: flow.id,
          nonce: input.nonce,
        });
        const cookieMaxAgeSeconds = remainingSeconds();
        return bound && cookieMaxAgeSeconds > 0
          ? { kind: 'oauth', ...bound, cookieMaxAgeSeconds }
          : null;
      }
      descriptor(flow);
      const secret = randomBytes(32).toString('base64url');
      input.signal.throwIfAborted();
      const [bound] = await db
        .update(schema.managedConnectorAuthFlow)
        .set({
          browserBoundAt: new Date(),
          browserCompletionHash: hash(secret),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
            eq(schema.managedConnectorAuthFlow.id, flow.id),
            eq(schema.managedConnectorAuthFlow.ownerUserId, input.ownerId),
            eq(schema.managedConnectorAuthFlow.state, 'waiting'),
            eq(schema.managedConnectorAuthFlow.completionKind, flow.completionKind),
            isNull(schema.managedConnectorAuthFlow.browserBoundAt),
            gt(schema.managedConnectorAuthFlow.expiresAt, new Date())
          )
        )
        .returning();
      const cookieMaxAgeSeconds = remainingSeconds();
      return bound && cookieMaxAgeSeconds > 0
        ? { ...page(bound, secret), cookieValue: `${flow.id}.${secret}`, cookieMaxAgeSeconds }
        : null;
    },
    async readFieldsPage(input) {
      input.signal.throwIfAborted();
      const parts = cookieParts(input.cookieValue);
      if (!parts) return null;
      const flow = await waiting(input.ownerId, parts.flowId);
      if (
        !flow ||
        flow.completionKind === 'oauth' ||
        !flow.browserBoundAt ||
        !flow.browserCompletionHash ||
        !equalHash(parts.secret, flow.browserCompletionHash)
      )
        return null;
      const config = configuration();
      const boundMaterial = material(flow, config);
      if (!(await authority(flow, boundMaterial.executionConfigDigest))) return null;
      // Pure reads: refresh and back navigation cannot consume the pending flow.
      return page(flow, parts.secret);
    },
    async completeFields(input) {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
      signal.throwIfAborted();
      const config = configuration();
      const expectedOrigin = new URL(config.callbackOrigin!).origin;
      if (input.expectedOrigin !== expectedOrigin || input.requestOrigin !== expectedOrigin)
        return refuse();
      const parts = cookieParts(input.cookieValue);
      if (!parts) return refuse();
      const flow = await waiting(input.ownerId, parts.flowId);
      if (
        !flow ||
        flow.completionKind === 'oauth' ||
        !flow.browserBoundAt ||
        !flow.browserCompletionHash ||
        !equalHash(parts.secret, flow.browserCompletionHash)
      )
        return refuse();
      if (
        input.descriptorDigest !== flow.authenticationDescriptorDigest ||
        !equalHash(input.csrfToken, hash(csrf(flow, parts.secret)))
      )
        return refuse();
      const selected = descriptor(flow);
      // Validate locally before any upstream request; never persist field values or provider errors.
      const fields = validateComposioAuthenticationFields(selected, input.fields);
      const boundMaterial = material(flow, config);
      if (!(await authority(flow, boundMaterial.executionConfigDigest))) return refuse();
      await freshDescriptor(flow, boundMaterial.accounts, signal);
      signal.throwIfAborted();
      const consumed = await db.transaction(async (tx) => {
        const [instance] = await tx
          .select({ id: schema.instance.id })
          .from(schema.instance)
          .where(
            and(
              eq(schema.instance.id, flow.instanceId),
              eq(schema.instance.userId, input.ownerId),
              isNull(schema.instance.revokedAt)
            )
          )
          .for('update');
        if (!instance) return undefined;
        const [provider] = await tx
          .select({ id: schema.managedConnectorProvider.id })
          .from(schema.managedConnectorProvider)
          .where(
            and(
              eq(schema.managedConnectorProvider.tenantId, flow.tenantId),
              eq(schema.managedConnectorProvider.id, flow.providerInstanceId),
              eq(schema.managedConnectorProvider.enabled, true),
              eq(schema.managedConnectorProvider.materialGeneration, flow.materialGeneration),
              eq(
                schema.managedConnectorProvider.configurationDigest,
                boundMaterial.executionConfigDigest
              )
            )
          )
          .for('update');
        if (!provider) return undefined;
        const [claimed] = await tx
          .update(schema.managedConnectorAuthFlow)
          .set({ state: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
              eq(schema.managedConnectorAuthFlow.id, flow.id),
              eq(schema.managedConnectorAuthFlow.ownerUserId, input.ownerId),
              eq(schema.managedConnectorAuthFlow.state, 'waiting'),
              eq(schema.managedConnectorAuthFlow.completionKind, selected.kind),
              eq(
                schema.managedConnectorAuthFlow.authenticationDescriptorDigest,
                input.descriptorDigest
              ),
              eq(
                schema.managedConnectorAuthFlow.browserCompletionHash,
                flow.browserCompletionHash!
              ),
              gt(schema.managedConnectorAuthFlow.expiresAt, new Date())
            )
          )
          .returning();
        return claimed;
      });
      if (!consumed) return refuse();
      let createdAccountId: string | undefined;
      try {
        signal.throwIfAborted();
        const created = await boundMaterial.accounts.createFieldAccount({
          providerUserId: flow.providerUserId,
          authConfigId: flow.authConfigId,
          descriptor: selected,
          fields,
          signal,
        });
        createdAccountId = created.connectedAccountId;
        const [recorded] = await db
          .update(schema.managedConnectorAuthFlow)
          .set({ provisionalExternalAccountRef: created.connectedAccountId, updatedAt: new Date() })
          .where(
            and(
              eq(schema.managedConnectorAuthFlow.tenantId, flow.tenantId),
              eq(schema.managedConnectorAuthFlow.id, flow.id),
              eq(schema.managedConnectorAuthFlow.state, 'consumed')
            )
          )
          .returning();
        if (!recorded) throw new Error('Account status was not recorded.');
        const account = await boundMaterial.accounts.getAccount(created.connectedAccountId, signal);
        const connectionId = await persistVerifiedManagedConnection({
          db,
          flow: recorded,
          account,
          executionConfigDigest: boundMaterial.executionConfigDigest,
          expectedFlowState: 'consumed',
        });
        return { connectionId };
      } catch (error) {
        try {
          await db
            .update(schema.managedConnectorAuthFlow)
            .set({
              // Retain a successful create's exact handle even if its first DB write failed.
              ...(createdAccountId ? { provisionalExternalAccountRef: createdAccountId } : {}),
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
        } catch {
          // A continuing DB outage cannot authorize replay or expose the underlying error.
        }
        throw new ManagedAuthenticationFlowError(
          'unavailable',
          'Account setup could not be confirmed. Check its status before starting another setup.'
        );
      }
    },
  };
}
