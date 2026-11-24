/** Shared helpers for the WebhookAdapter test files: secrets, signing and a configured adapter. */
import crypto from 'node:crypto';
import { WebhookAdapter } from '../webhook-adapter.js';

// --- Constants ---

export const SECRET = 'a-very-long-secret-at-least-16chars';
export const PREV_SECRET = 'old-secret-min-16-chars-for-rotation';
export const OUTBOUND_URL = 'https://example.com/webhook-receiver';

// --- Helpers ---

/** Sign a body string exactly as `WebhookAdapter.handleInbound` expects. */
export function signBody(
  body: string,
  secret: string,
  timestampSecs?: number
): { signature: string; timestamp: string; nonce: string } {
  const ts = String(timestampSecs ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const message = `${ts}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return { signature, timestamp: ts, nonce };
}

/** Build headers object in the shape `handleInbound` expects. */
export function buildHeaders(
  body: string,
  secret: string,
  timestampSecs?: number
): Record<string, string> {
  const signed = signBody(body, secret, timestampSecs);
  return {
    'x-signature': signed.signature,
    'x-timestamp': signed.timestamp,
    'x-nonce': signed.nonce,
  };
}

export function makeAdapter(opts?: {
  inboundSubject?: string;
  secret?: string;
  previousSecret?: string;
  outboundUrl?: string;
  outboundSecret?: string;
}): WebhookAdapter {
  return new WebhookAdapter('test-webhook', {
    inbound: {
      subject: opts?.inboundSubject ?? 'relay.webhook.test',
      secret: opts?.secret ?? SECRET,
      previousSecret: opts?.previousSecret,
    },
    outbound: {
      url: opts?.outboundUrl ?? OUTBOUND_URL,
      secret: opts?.outboundSecret ?? SECRET,
    },
  });
}
