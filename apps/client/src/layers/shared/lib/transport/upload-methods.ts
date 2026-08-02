/**
 * Multipart attachment upload over `XMLHttpRequest`.
 *
 * Its own module rather than one more method on the system-methods grab bag,
 * because it is the only transport call with a progress channel, a watchdog and
 * a cancel to keep straight — and `fetch` still cannot report upload progress.
 *
 * @module shared/lib/transport/upload-methods
 */
import type { UploadResult, UploadProgress } from '@dorkos/shared/types';
import type { UploadFile } from '@dorkos/shared/transport';
import {
  UPLOAD_CANCELED_MESSAGE,
  UPLOAD_STALLED_MESSAGE,
  UPLOAD_STALL_TIMEOUT_MS,
} from './upload-contract';

/**
 * Upload files over a request that can always be ended — by the person, or by
 * the clock.
 *
 * `xhr.timeout` is deliberately not used: it caps total duration, which would
 * abort a large file that is uploading perfectly well. The watchdog below
 * measures SILENCE instead, restarted by every byte in either direction, so
 * slow-but-alive is left alone and dead-but-open is not.
 *
 * @param baseUrl - API base URL
 * @param files - Files to upload
 * @param cwd - Working directory the files are stored under
 * @param onProgress - Called as the request body goes out
 * @param signal - Aborts the request itself, not just this promise
 */
export async function uploadFilesOverHttp(
  baseUrl: string,
  files: UploadFile[],
  cwd: string,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal
): Promise<UploadResult[]> {
  const formData = new FormData();
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    formData.append('files', new Blob([buffer], { type: file.type }), file.name);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/uploads?cwd=${encodeURIComponent(cwd)}`);
    // Ride the Better Auth session cookie on the multipart upload (login enabled).
    xhr.withCredentials = true;

    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Give up on a connection that has said nothing for too long.
     *
     * The `abort()` runs AFTER the rejection on purpose: aborting fires the
     * `abort` listener below, which would otherwise overwrite the stall with the
     * cancel wording — as if the person had pressed something. A promise keeps
     * its first settlement, so the reason recorded here is the one the caller
     * sees.
     */
    const giveUp = () => {
      reject(new Error(UPLOAD_STALLED_MESSAGE));
      xhr.abort();
    };

    /** Restart the silence clock — called on every sign of life. */
    const heardSomething = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(giveUp, UPLOAD_STALL_TIMEOUT_MS);
    };

    xhr.upload.addEventListener('progress', (e) => {
      heardSomething();
      if (onProgress && e.lengthComputable) {
        onProgress({
          loaded: e.loaded,
          total: e.total,
          percentage: Math.round((e.loaded / e.total) * 100),
        });
      }
    });
    // The response side counts as life too, so a server that streams a slow
    // reply after the body lands is not mistaken for a dead connection.
    xhr.addEventListener('progress', heardSomething);

    xhr.addEventListener('load', () => {
      clearTimeout(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { uploads: UploadResult[] }).uploads);
      } else {
        try {
          const error =
            (JSON.parse(xhr.responseText) as { error?: string }).error ?? `HTTP ${xhr.status}`;
          reject(new Error(error));
        } catch {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => {
      clearTimeout(stallTimer);
      reject(new Error('Upload failed'));
    });
    xhr.addEventListener('abort', () => {
      clearTimeout(stallTimer);
      reject(new Error(UPLOAD_CANCELED_MESSAGE));
    });

    // A signal already aborted before the request left never reaches the
    // listener, so check it as well as subscribe to it.
    if (signal?.aborted) {
      reject(new Error(UPLOAD_CANCELED_MESSAGE));
      return;
    }
    signal?.addEventListener('abort', () => {
      clearTimeout(stallTimer);
      xhr.abort();
    });

    xhr.send(formData);
    // Arm the watchdog at send: a request that never reaches the network emits
    // no progress at all, and that is the deadest connection there is.
    heardSomething();
  });
}
