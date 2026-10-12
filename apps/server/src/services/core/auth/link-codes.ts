/**
 * The codes a person approves a link with, as the app is handed them.
 *
 * @module services/core/auth/link-codes
 */
import type { StartLinkResult } from '@dorkos/shared/cloud-schemas';
import type { DeviceCodeResponse } from './cloud-link-client.js';

/**
 * Whether the service's filled-in address may be handed to a browser: an http
 * or https URL. Anything else is dropped, and the app opens the plain address.
 */
function openableUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build what `POST /api/cloud/link/start` answers from the service's device
 * code (RFC 8628). `verificationUriComplete` is forwarded only when the service
 * sent one (spec `one-minute-onboarding` §5.1).
 *
 * @param codes - The service's device-code response.
 * @param nowMs - The current time, for the expiry.
 */
export function startLinkResultFrom(codes: DeviceCodeResponse, nowMs: number): StartLinkResult {
  const complete = openableUrl(codes.verification_uri_complete);
  return {
    userCode: codes.user_code,
    verificationUri: codes.verification_uri,
    ...(complete ? { verificationUriComplete: complete } : {}),
    expiresAt: new Date(nowMs + codes.expires_in * 1000).toISOString(),
  };
}
