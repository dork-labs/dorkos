# Webhook Adapter Setup

Connect DorkOS to any external service using HMAC-signed HTTP webhooks.

## Overview

The Webhook adapter supports bidirectional communication:

- **Inbound**: External services POST JSON payloads to DorkOS. Each request is verified using HMAC-SHA256 signature verification before being published to the Relay message bus.
- **Outbound**: DorkOS POSTs messages to an external URL, signing each request with HMAC-SHA256 so the receiving service can verify authenticity.
- **Bidirectional**: Configure both directions on the same adapter instance for full two-way communication.

All signature verification follows the Stripe-style format: the HMAC is computed over `{timestamp}.{raw_body}`, combining a timestamp with the raw request body to prevent both tampering and replay attacks.

## Inbound Webhooks

### Endpoint URL

External services send webhooks to:

```
POST /api/relay/webhooks/:adapterId
```

Replace `:adapterId` with the ID assigned when you create the adapter in DorkOS (visible in the Relay settings panel).

### Subject Naming

Inbound messages are published to the Relay subject you configure (e.g., `relay.webhook.github`, `relay.webhook.stripe`). Use a descriptive name that identifies the source service.

### Request Format

Requests must be `POST` with a JSON body and include three required headers:

| Header        | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `X-Signature` | HMAC-SHA256 hex digest of `{timestamp}.{raw_body}`           |
| `X-Timestamp` | Unix epoch timestamp (seconds) when the request was created  |
| `X-Nonce`     | Unique identifier for this request (prevents replay attacks) |

The signature is computed as:

```
HMAC-SHA256(secret, "{X-Timestamp}.{raw_body}")
```

### Security Model

DorkOS applies three layers of verification to every inbound webhook:

1. **Signature verification** -- the HMAC digest must match, proving the sender knows the shared secret
2. **Timestamp window** -- the request timestamp must be within 5 minutes of the server clock, preventing old requests from being replayed
3. **Nonce deduplication** -- each nonce can only be used once within a 24-hour window, preventing duplicate delivery

## Outbound Webhooks

### URL Requirements

The outbound URL must:

- Accept **POST** requests with a `Content-Type: application/json` body
- Return a **2xx** status code to indicate success
- The response body is ignored by DorkOS

### Signed Requests

DorkOS signs every outbound request using the same HMAC-SHA256 scheme. The receiving service can verify authenticity by checking the `X-Signature`, `X-Timestamp`, and `X-Nonce` headers against the shared outbound secret.

### Custom Headers

Provide a JSON object of additional HTTP headers sent with every outbound request. This is useful for authentication tokens or routing metadata:

```json
{
  "Authorization": "Bearer your-api-key",
  "X-Custom-Header": "value"
}
```

Leave this field empty if no custom headers are needed.

## Secret Generation

Both inbound and outbound directions require a shared secret for HMAC signing. Generate a secure random secret (minimum 16 characters):

```bash
openssl rand -hex 32
```

This produces a 64-character hex string suitable for HMAC-SHA256 signing.

### Secret Rotation

The adapter supports zero-downtime secret rotation via the `previousSecret` field. When rotating secrets:

1. Set the new secret as the primary secret
2. Move the old secret to `previousSecret`
3. Update the external service to use the new secret
4. Once all traffic uses the new secret, clear `previousSecret`

During the transition period, DorkOS accepts signatures from either secret.

## Testing

Send a test inbound webhook using `curl`:

```bash
# Set your variables
SECRET="your-inbound-secret"
ADAPTER_ID="your-adapter-id"
TIMESTAMP=$(date +%s)
BODY='{"text": "Hello from webhook"}'
NONCE=$(uuidgen)

# Compute the HMAC-SHA256 signature
SIGNATURE=$(echo -n "${TIMESTAMP}.${BODY}" | \
  openssl dgst -sha256 -hmac "${SECRET}" | cut -d' ' -f2)

# Send the request
curl -X POST "http://localhost:6242/api/relay/webhooks/${ADAPTER_ID}" \
  -H "Content-Type: application/json" \
  -H "X-Signature: ${SIGNATURE}" \
  -H "X-Timestamp: ${TIMESTAMP}" \
  -H "X-Nonce: ${NONCE}" \
  -d "${BODY}"
```

### Expected Responses

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `200`  | Webhook received and published to Relay                                          |
| `401`  | Signature verification failed (wrong secret, expired timestamp, or reused nonce) |
| `400`  | Missing required headers or invalid JSON body                                    |
| `404`  | Adapter ID not found or adapter is not running                                   |

### Common Errors

- **401 with "invalid signature"** -- the secret used to sign the request does not match the configured inbound secret. Verify both sides use the same value.
- **401 with "timestamp expired"** -- the `X-Timestamp` is more than 5 minutes old. Ensure the sending service's clock is synchronized (NTP).
- **401 with "nonce already used"** -- the same `X-Nonce` value was sent twice. Generate a unique nonce for every request.
