/** Owner-scoped BYO webhook setup and independent local event content keys. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  connectorEventProviderSettings,
  connectorProviderInstances,
  eq,
  type Db,
} from '@dorkos/db';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { CredentialProvider, CredentialStore } from '../../core/credential-provider.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import { ConnectorSubscriptionError } from './subscription-store.js';
import type { ConnectorEventProtectionPort } from './ingress-service.js';

const KeyRingSchema = z
  .object({
    activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    keys: z.record(
      z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
    ),
  })
  .strict();
const SetupSchema = z
  .object({ webhookSecret: z.string().min(16).max(4096), publicOrigin: z.string().url() })
  .strict();

/** Independent encrypted credential references; no raw key or webhook secret is returned. */
export class ConnectorEventSettingsService implements ConnectorEventProtectionPort {
  private readonly initialization = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Db,
    private readonly credentials: CredentialProvider,
    private readonly secrets: CredentialStore,
    private readonly reload: (providerInstanceId: string) => Promise<void>,
    private readonly now = () => new Date().toISOString()
  ) {}

  /** Current webhook secret reference for private provider composition only. */
  webhookSecretRef(providerInstanceId: string): string | undefined {
    try {
      const expected = `file:connector-events-${this.identity(this.provider(providerInstanceId))}-webhook`;
      const ref = this.db
        .select({ ref: connectorEventProviderSettings.webhookSecretRef })
        .from(connectorEventProviderSettings)
        .where(eq(connectorEventProviderSettings.providerInstanceId, providerInstanceId))
        .get()?.ref;
      return ref === expected ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  /** Read only the endpoint/configured projection beneath the exact connection owner. */
  describe(owner: ConnectorOwnerAuthority, providerInstanceId: string) {
    const provider = this.owned(owner, providerInstanceId);
    const setupMode =
      provider.mode === 'managed' && provider.type === 'dorkos-managed'
        ? ('managed' as const)
        : provider.mode === 'byo' && provider.type === 'composio'
          ? ('byo_webhook' as const)
          : ('unavailable' as const);
    const row = this.db
      .select()
      .from(connectorEventProviderSettings)
      .where(eq(connectorEventProviderSettings.providerInstanceId, providerInstanceId))
      .get();
    const configured = Boolean(this.webhookSecretRef(providerInstanceId) && row?.publicEndpoint);
    return {
      setupMode,
      configured: setupMode === 'byo_webhook' && configured,
      endpoint: setupMode === 'byo_webhook' && configured ? row!.publicEndpoint : null,
      reason:
        setupMode === 'unavailable' ? 'Notifications are not available for this service.' : null,
    };
  }

  /** Save the write-only signing secret for the owner's BYO project and report its exact endpoint. */
  async configure(
    owner: ConnectorOwnerAuthority,
    providerInstanceId: string,
    raw: z.infer<typeof SetupSchema>
  ) {
    const input = SetupSchema.parse(raw);
    const expected = this.owned(owner, providerInstanceId);
    if (expected.mode !== 'byo' || expected.type !== 'composio')
      throw new ConnectorSubscriptionError('events_unavailable');
    const origin = new URL(input.publicOrigin);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new ConnectorSubscriptionError('events_unavailable');
    await this.ensureProtection(providerInstanceId);
    const name = `connector-events-${this.identity(expected)}-webhook`;
    const ref = await this.secrets.put(name, input.webhookSecret);
    this.db.transaction(() => {
      if (stableStringify(this.owned(owner, providerInstanceId)) !== stableStringify(expected))
        throw new ConnectorSubscriptionError('not_found');
      this.db
        .update(connectorEventProviderSettings)
        .set({
          webhookSecretRef: ref,
          publicEndpoint: `${origin.origin}/api/connectors/webhooks/${encodeURIComponent(providerInstanceId)}`,
          updatedAt: this.now(),
        })
        .where(eq(connectorEventProviderSettings.providerInstanceId, providerInstanceId))
        .run();
    });
    await this.reload(providerInstanceId);
    return this.describe(owner, providerInstanceId);
  }

  /** Resolve a separate local content key ring; token/project/webhook keys never substitute for it. */
  async resolve(providerInstanceId: string): Promise<ConnectorEventPayloadProtector | undefined> {
    try {
      await this.ensureProtection(providerInstanceId);
      const row = this.db
        .select({ ref: connectorEventProviderSettings.payloadKeyRef })
        .from(connectorEventProviderSettings)
        .where(eq(connectorEventProviderSettings.providerInstanceId, providerInstanceId))
        .get();
      if (!row) return undefined;
      const secret = await this.credentials.resolve(row.ref);
      if (!secret.ok || secret.secret.length > 8192) return undefined;
      const parsed = KeyRingSchema.parse(JSON.parse(secret.secret));
      return new ConnectorEventPayloadProtector({
        activeKeyId: parsed.activeKeyId,
        keys: new Map(
          Object.entries(parsed.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])
        ),
      });
    } catch {
      return undefined;
    }
  }

  private async ensureProtection(providerInstanceId: string): Promise<void> {
    const expectedRef = `file:connector-events-${this.identity(this.provider(providerInstanceId))}-payload`;
    const stored = this.db
      .select({ ref: connectorEventProviderSettings.payloadKeyRef })
      .from(connectorEventProviderSettings)
      .where(eq(connectorEventProviderSettings.providerInstanceId, providerInstanceId))
      .get();
    if (stored?.ref === expectedRef) return;
    const existing = this.initialization.get(providerInstanceId);
    if (existing) return existing;
    const pending = this.createProtection(providerInstanceId);
    this.initialization.set(providerInstanceId, pending);
    try {
      await pending;
    } finally {
      this.initialization.delete(providerInstanceId);
    }
  }

  private async createProtection(providerInstanceId: string): Promise<void> {
    const expected = this.provider(providerInstanceId);
    const name = `connector-events-${this.identity(expected)}-payload`;
    // A crash after the credential write but before the SQLite reference commit
    // must recover that key, not overwrite it and strand already protected data.
    const previous = await this.secrets.get(name);
    let keyRing = previous;
    if (!keyRing) {
      const keyId = randomUUID();
      keyRing = JSON.stringify({
        activeKeyId: keyId,
        keys: { [keyId]: randomBytes(32).toString('base64') },
      });
    }
    KeyRingSchema.parse(JSON.parse(keyRing));
    const ref = await this.secrets.put(name, keyRing);
    this.db.transaction(() => {
      if (stableStringify(this.provider(providerInstanceId)) !== stableStringify(expected))
        throw new ConnectorSubscriptionError('not_found');
      this.db
        .insert(connectorEventProviderSettings)
        .values({
          providerInstanceId,
          webhookSecretRef: '',
          payloadKeyRef: ref,
          publicEndpoint: '',
          updatedAt: this.now(),
        })
        .onConflictDoUpdate({
          target: connectorEventProviderSettings.providerInstanceId,
          set: {
            webhookSecretRef: '',
            payloadKeyRef: ref,
            publicEndpoint: '',
            updatedAt: this.now(),
          },
        })
        .run();
    });
  }

  private provider(providerInstanceId: string) {
    const row = this.db
      .select({
        id: connectorProviderInstances.id,
        type: connectorProviderInstances.type,
        mode: connectorProviderInstances.mode,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, providerInstanceId))
      .get();
    if (!row?.ownerId || !row.ownerKind) throw new ConnectorSubscriptionError('not_found');
    return row;
  }

  private owned(owner: ConnectorOwnerAuthority, providerInstanceId: string) {
    const expectedOwnerId = owner.kind === 'user' ? owner.userId : owner.installationId;
    const provider = this.provider(providerInstanceId);
    if (provider.ownerKind !== owner.kind || provider.ownerId !== expectedOwnerId)
      throw new ConnectorSubscriptionError('not_found');
    return provider;
  }

  private identity(provider: ReturnType<ConnectorEventSettingsService['provider']>) {
    return createHash('sha256').update(stableStringify(provider)).digest('hex');
  }
}
