/** Non-replayable hosted blueprint resolution, never a grant or account authority. */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  matchesComposioAutomaticAuthenticationPolicy,
  selectComposioAuthentication,
  type ComposioAuthenticationConfiguration,
  type ComposioAuthenticationDescriptor,
  type ComposioManagedAccountClient,
} from '@dorkos/connector-providers/composio';
import { schema } from '@/db/client';
import type { ManagedConnectorDatabase } from './authority-service';

/** Exact adapter port used by synthetic SQL concurrency tests and real requests. */
export type ManagedAuthenticationConfigurationClient = Pick<
  ComposioManagedAccountClient,
  | 'authConfigProjectDigest'
  | 'getToolkitAuthentication'
  | 'getAuthenticationConfiguration'
  | 'listAuthenticationConfigurations'
  | 'createAuthenticationConfiguration'
>;

/** Immutable configuration/field selection recorded on a single owner flow. */
export interface ManagedResolvedAuthentication {
  authConfigId: string;
  descriptor: ComposioAuthenticationDescriptor;
  descriptorDigest: string;
}

/** Stable field metadata digest; raw credentials are never an input. */
export function managedAuthenticationDescriptorDigest(
  descriptor: ComposioAuthenticationDescriptor
): string {
  return createHash('sha256').update(stableStringify(descriptor)).digest('hex');
}

function unavailable(): never {
  throw new Error(
    'Account setup could not be confirmed. Check the existing setup before trying again.'
  );
}

/** Resolve explicit settings first, otherwise claim one bounded default blueprint attempt. */
export async function resolveManagedAuthenticationConfiguration(input: {
  db: ManagedConnectorDatabase;
  accounts: ManagedAuthenticationConfigurationClient;
  toolkit: string;
  configuredAuthConfigId?: string;
  signal: AbortSignal;
}): Promise<ManagedResolvedAuthentication> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const toolkit = await input.accounts.getToolkitAuthentication(input.toolkit, signal);
  if (toolkit.toolkit !== input.toolkit) return unavailable();
  // A bad explicit mapping never silently falls back to a new managed config.
  const configured = input.configuredAuthConfigId
    ? await input.accounts.getAuthenticationConfiguration(input.configuredAuthConfigId, signal)
    : undefined;
  if (configured && configured.id !== input.configuredAuthConfigId) return unavailable();
  const descriptor = selectComposioAuthentication(toolkit, configured);
  const descriptorDigest = managedAuthenticationDescriptorDigest(descriptor);
  if (configured) return { authConfigId: configured.id, descriptor, descriptorDigest };

  const policyDigest = createHash('sha256')
    .update(
      stableStringify({
        version: 1,
        descriptor,
        managedScopes: [...toolkit.managedScopes].sort(),
        managedUserScopes: [...toolkit.managedUserScopes].sort(),
      })
    )
    .digest('hex');
  const projectDigest = input.accounts.authConfigProjectDigest;
  const name = `dorkos-default-v1-${input.toolkit}-${policyDigest.slice(0, 24)}`;
  const table = schema.managedConnectorAuthConfigResolution;
  const key = and(
    eq(table.projectDigest, projectDigest),
    eq(table.toolkit, input.toolkit),
    eq(table.policyDigest, policyDigest)
  );
  const attemptId = randomUUID();
  signal.throwIfAborted();
  // No transaction spans provider I/O. A durable claim must complete before a create is possible.
  const [claimed] = await input.db
    .insert(table)
    .values({
      projectDigest,
      toolkit: input.toolkit,
      policyDigest,
      name,
      attemptId,
      state: 'provisioning',
    })
    .onConflictDoNothing()
    .returning();
  const [existing] = claimed ? [claimed] : await input.db.select().from(table).where(key).limit(1);
  if (!existing || existing.name !== name) return unavailable();
  const matches = (config: ComposioAuthenticationConfiguration): boolean =>
    config.enabled &&
    config.name === name &&
    config.toolkit === input.toolkit &&
    config.scheme === descriptor.scheme &&
    matchesComposioAutomaticAuthenticationPolicy(config, toolkit, descriptor);
  const result = (id: string): ManagedResolvedAuthentication => ({
    authConfigId: id,
    descriptor,
    descriptorDigest,
  });
  if (existing.state === 'ready') {
    if (!existing.authConfigId) return unavailable();
    const config = await input.accounts.getAuthenticationConfiguration(
      existing.authConfigId,
      signal
    );
    if (config.id !== existing.authConfigId || !matches(config)) return unavailable();
    return result(config.id);
  }
  if (!claimed && existing.state === 'provisioning') {
    // The whole attempt has a 30s signal. After 60s, its create outcome is uncertain, never retryable.
    if (Date.now() - existing.updatedAt.getTime() < 60_000) return unavailable();
    await input.db
      .update(table)
      .set({ state: 'create_unknown', updatedAt: new Date() })
      .where(and(key, eq(table.attemptId, existing.attemptId), eq(table.state, 'provisioning')));
  }
  try {
    const candidates: ComposioAuthenticationConfiguration[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      signal.throwIfAborted();
      const page = await input.accounts.listAuthenticationConfigurations({
        toolkit: input.toolkit,
        name,
        ...(cursor ? { cursor } : {}),
        signal,
      });
      candidates.push(...page.items.filter((item) => item.name === name));
      if (!page.nextCursor) {
        cursor = undefined;
        break;
      }
      if (seen.has(page.nextCursor)) return unavailable();
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (cursor || candidates.length > 1 || (candidates.length === 1 && !matches(candidates[0])))
      return unavailable();
    let configId = candidates[0]?.id;
    if (!configId) {
      if (!claimed) return unavailable(); // Unknown creates are reconciled by reads only.
      signal.throwIfAborted();
      const created = await input.accounts.createAuthenticationConfiguration({
        descriptor,
        name,
        signal,
      });
      configId = created.id;
      const [recorded] = await input.db
        .update(table)
        .set({ authConfigId: configId, updatedAt: new Date() })
        .where(and(key, eq(table.attemptId, attemptId), eq(table.state, 'provisioning')))
        .returning();
      if (!recorded) return unavailable();
    }
    const config = await input.accounts.getAuthenticationConfiguration(configId, signal);
    if (config.id !== configId || !matches(config)) return unavailable();
    const [ready] = await input.db
      .update(table)
      .set({ authConfigId: configId, state: 'ready', updatedAt: new Date() })
      .where(
        and(
          key,
          eq(table.attemptId, existing.attemptId),
          eq(table.state, claimed ? 'provisioning' : 'create_unknown')
        )
      )
      .returning();
    if (!ready) return unavailable();
    return result(configId);
  } catch {
    // Even a known rejection is terminal for this attempt. Never repeat a possibly dispatched create.
    if (claimed)
      await input.db
        .update(table)
        .set({ state: 'create_unknown', updatedAt: new Date() })
        .where(and(key, eq(table.attemptId, attemptId), eq(table.state, 'provisioning')));
    return unavailable();
  }
}
