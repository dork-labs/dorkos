/** Project signature verification precedes every hosted tenant or account lookup. */
import { Composio } from '@composio/core';
import {
  CONNECTOR_EVENT_MAX_RAW_BYTES,
  CONNECTOR_EVENT_SIGNATURE_TOLERANCE_SECONDS,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorRawWebhook } from '@dorkos/shared/connector-events';

/** Verify a bounded signed envelope without inferring account or tenant ownership. */
export async function verifyComposioWebhook(
  sdk: Composio,
  secret: string | undefined,
  input: ConnectorRawWebhook
) {
  const reject = (code: string) => ({ status: 'rejected' as const, code });
  if (!secret) return reject('VERIFIER_UNAVAILABLE');
  if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > CONNECTOR_EVENT_MAX_RAW_BYTES)
    return reject('INVALID_BODY_SIZE');
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(input.webhookId) ||
    input.webhookSignature.length > 4_096 ||
    !/^[1-9][0-9]{0,12}$/.test(input.webhookTimestamp)
  )
    return reject('INVALID_SIGNATURE_HEADERS');
  const timestamp = Number(input.webhookTimestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Date.now() / 1_000 - timestamp) > CONNECTOR_EVENT_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return reject('STALE_SIGNATURE');
  }
  try {
    const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      input.rawBody
    );
    const result = await sdk.triggers.verifyWebhook({
      id: input.webhookId,
      timestamp: input.webhookTimestamp,
      signature: input.webhookSignature,
      payload,
      secret: secret,
      tolerance: CONNECTOR_EVENT_SIGNATURE_TOLERANCE_SECONDS,
    });
    if (result.version !== 'V1' && result.version !== 'V2') return reject('UNSUPPORTED_ENVELOPE');
    const normalized = result.payload;
    if (!normalized.id || !normalized.metadata.connectedAccount.id || !normalized.triggerSlug)
      return reject('INVALID_BINDING');
    return {
      status: 'verified' as const,
      event: {
        authenticatedWebhookId: input.webhookId,
        envelopeVersion: result.version,
        providerTriggerRef: normalized.id,
        externalAccountRef: normalized.metadata.connectedAccount.id,
        ...(result.version === 'V2' && {
          providerTriggerUuid: normalized.uuid,
          externalAccountUuid: normalized.metadata.connectedAccount.uuid,
          providerUserRef: normalized.userId,
        }),
        eventType: normalized.triggerSlug,
        payload: normalized.payload ?? {},
      },
    };
  } catch {
    return reject('INVALID_SIGNATURE_OR_PAYLOAD');
  }
}

/** Hosted project-level verifier with no mutation or network methods. */
export class ComposioWebhookVerifier {
  private readonly sdk: Composio;
  constructor(
    private readonly secret: string,
    apiKey: string
  ) {
    this.sdk = new Composio({
      apiKey,
      allowTracking: false,
      disableVersionCheck: true,
      dangerouslyAllowAutoUploadDownloadFiles: false,
    });
  }
  /** A verified signature authenticates content, not any tenant claim in it. */
  verifyWebhook(input: ConnectorRawWebhook) {
    return verifyComposioWebhook(this.sdk, this.secret, input);
  }
}
