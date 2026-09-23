/**
 * Send an owner export to the local server to start a move
 * (community-host-operator-api P5).
 *
 * Its own module because it is the one hosted-community call with a progress
 * channel, and `fetch` still cannot report upload progress. The file goes as the
 * raw request body, straight from disk: nothing is read into memory here, which
 * matters for an export of several hundred megabytes. The local server measures
 * it, starts the move, and sends it on to the Community server itself, so the
 * upload token never reaches this page.
 *
 * @module shared/lib/transport/community-move-methods
 */
import type {
  CloudCommunityMoveResponse,
  CloudCommunityMoveStartInput,
} from '@dorkos/shared/cloud-schemas';
import {
  UPLOAD_CANCELED_MESSAGE,
  UPLOAD_STALLED_MESSAGE,
  UPLOAD_STALL_TIMEOUT_MS,
} from './upload-contract';
import { buildQueryString } from './http-client';

/**
 * Whether a parsed body is the move route's answer.
 *
 * @param body - The parsed response body.
 */
function isMoveResponse(body: unknown): body is CloudCommunityMoveResponse {
  return (
    typeof body === 'object' && body !== null && typeof (body as { ok?: unknown }).ok === 'boolean'
  );
}

/**
 * Start a move by sending the export to the local server.
 *
 * Resolves with the route's answer, a refusal included; rejects only when no
 * answer arrived (the connection broke, went silent, or was cancelled).
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 * @param file - The owner export.
 * @param input - The idempotency key, the name and the optional web address.
 * @param onProgress - Called as the file reaches the local server.
 * @param signal - Stops sending.
 */
export function startHostedCommunityMoveOverHttp(
  baseUrl: string,
  file: Blob,
  input: CloudCommunityMoveStartInput,
  onProgress?: (progress: { loaded: number; total: number }) => void,
  signal?: AbortSignal
): Promise<CloudCommunityMoveResponse> {
  const url = `${baseUrl}/cloud/communities/moves${buildQueryString({
    idempotencyKey: input.idempotencyKey,
    name: input.name,
    shortName: input.shortName,
  })}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(UPLOAD_CANCELED_MESSAGE));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    // Ride the session cookie when login is on, like every other call.
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/zip');
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // Silence, not duration: a big export on a slow link is healthy, a
    // connection that has said nothing for the stall window is not.
    const heardSomething = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        reject(new Error(UPLOAD_STALLED_MESSAGE));
        xhr.abort();
      }, UPLOAD_STALL_TIMEOUT_MS);
    };
    xhr.upload.addEventListener('progress', (event) => {
      heardSomething();
      if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
    });
    xhr.addEventListener('progress', heardSomething);
    xhr.addEventListener('load', () => {
      clearTimeout(stallTimer);
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (isMoveResponse(body)) resolve(body);
      else reject(new Error(`HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => {
      clearTimeout(stallTimer);
      reject(new Error('Upload failed'));
    });
    xhr.addEventListener('abort', () => {
      clearTimeout(stallTimer);
      reject(new Error(UPLOAD_CANCELED_MESSAGE));
    });
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
    heardSomething();
  });
}
