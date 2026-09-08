/** Provider-neutral event normalization and authenticated at-rest payload protection. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  ConnectorEventContentSchema,
  CONNECTOR_EVENT_MAX_PAYLOAD_BYTES,
  type ConnectorEventContent,
  type ConnectorEventDefinition,
} from '@dorkos/shared/connector-event-schemas';

/** Retain a bounded set of notification text fields; never persist arbitrary provider objects. */
export function normalizeConnectorEventContent(
  definition: ConnectorEventDefinition,
  payload: Record<string, unknown>
): ConnectorEventContent {
  const text = ['subject', 'title', 'text', 'body', 'message', 'url']
    .flatMap((key) =>
      typeof payload[key] === 'string' ? [`${key}: ${payload[key].slice(0, 8_000)}`] : []
    )
    .join('\n')
    .slice(0, 48_000);
  return ConnectorEventContentSchema.parse({ version: 1, title: definition.displayName, text });
}

/** Scope authenticated with ciphertext to prevent cross-inbox substitution. */
export interface ConnectorEventPayloadScope {
  /** Required by shared hosted custody; local per-instance custody leaves this absent. */
  tenantId?: string;
  providerInstanceId: string;
  subscriptionId: string;
  providerEventId: string;
  expiresAt: string;
}

/** Independently managed AES-256-GCM keys; active key ID supports non-destructive rotation. */
export interface ConnectorEventPayloadKeys {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

/** Encrypt event content under a separate event key, bound to exact routing and original expiry. */
export class ConnectorEventPayloadProtector {
  constructor(private readonly config: ConnectorEventPayloadKeys) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(config.activeKeyId) ||
      !config.keys.has(config.activeKeyId) ||
      [...config.keys.values()].some((key) => key.byteLength !== 32)
    ) {
      throw new Error('Event content protection is not configured.');
    }
  }

  /** Produce a versioned, scope-authenticated envelope without exposing key material. */
  protect(content: ConnectorEventContent, scope: ConnectorEventPayloadScope): string {
    const body = JSON.stringify(ConnectorEventContentSchema.parse(content));
    if (Buffer.byteLength(body) > CONNECTOR_EVENT_MAX_PAYLOAD_BYTES)
      throw new Error('Event content is too large.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.config.keys.get(this.config.activeKeyId)!,
      nonce
    );
    cipher.setAAD(Buffer.from(this.aad(scope)));
    const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return [
      'v1',
      this.config.activeKeyId,
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  /** Resolve only unexpired content for its exact destination identity, with payload-free failures. */
  reveal(envelope: string, scope: ConnectorEventPayloadScope, now: number): ConnectorEventContent {
    try {
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(Date.parse(scope.expiresAt)) ||
        Date.parse(scope.expiresAt) <= now ||
        envelope.length > 100_000
      )
        throw new Error();
      const parts = envelope.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1') throw new Error();
      const [, keyId, nonce, tag, encrypted] = parts;
      const key = this.config.keys.get(keyId);
      if (
        !key ||
        !/^[A-Za-z0-9_-]+$/.test(nonce) ||
        !/^[A-Za-z0-9_-]+$/.test(tag) ||
        !/^[A-Za-z0-9_-]+$/.test(encrypted)
      )
        throw new Error();
      const iv = Buffer.from(nonce, 'base64url');
      const authTag = Buffer.from(tag, 'base64url');
      if (iv.length !== 12 || authTag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(this.aad(scope)));
      decipher.setAuthTag(authTag);
      const body = Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]);
      if (body.length > CONNECTOR_EVENT_MAX_PAYLOAD_BYTES) throw new Error();
      return ConnectorEventContentSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      );
    } catch {
      // Decryption/JSON/Zod errors can contain private content; this boundary must discard their causes.
      // eslint-disable-next-line preserve-caught-error -- prevent private payloads escaping through error causes
      throw new Error('Event content is unavailable.');
    }
  }

  private aad(scope: ConnectorEventPayloadScope): string {
    return JSON.stringify([
      'connector-event-v1',
      scope.tenantId ?? '',
      scope.providerInstanceId,
      scope.subscriptionId,
      scope.providerEventId,
      scope.expiresAt,
    ]);
  }
}
