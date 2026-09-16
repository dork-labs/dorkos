import type { CommunityWireError } from '@dorkos/shared/community-wire';

/** A network or API refusal with its status and stable code. */
export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Make a same-origin JSON request and normalize expected failures. */
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(
      0,
      'OFFLINE',
      'You appear to be offline. Check your connection and try again.'
    );
  }
  if (!response.ok) {
    let error: Partial<CommunityWireError> = {};
    try {
      error = (await response.json()) as Partial<CommunityWireError>;
    } catch {
      /* Empty or non-JSON response. */
    }
    throw new RequestError(
      response.status,
      error.code ?? 'UNAVAILABLE',
      error.message ?? recovery(response.status)
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Explain common HTTP failures in actionable language. */
export function recovery(status: number) {
  switch (status) {
    case 401:
      return 'Your session ended. Sign in again.';
    case 403:
      return 'You do not have access to this action.';
    case 404:
      return 'This item is no longer available.';
    case 409:
      return 'This changed while you were working. Refresh and try again.';
    case 410:
      return 'This view is out of date. Reload it to continue.';
    case 413:
      return 'This file or message is too large.';
    case 415:
      return 'This file type is not supported.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    case 503:
      return 'The community is temporarily unavailable. Try again shortly.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Turn an unknown failure into a user-facing message. */
export function describeError(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Something went wrong. Try again.';
}

/** Download an authorized response using the browser save flow. */
export async function download(path: string, fallbackName: string) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok)
    throw new RequestError(response.status, 'DOWNLOAD_FAILED', recovery(response.status));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fallbackName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Stream one attachment with progress and a stable retry key. */
export function upload(
  channelId: string,
  file: File,
  key: string,
  progress: (value: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/channels/${encodeURIComponent(channelId)}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-File-Size', String(file.size));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new RequestError(0, 'OFFLINE', recovery(503)));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { attachment: { id: string } }).attachment.id);
        } catch {
          reject(new RequestError(503, 'UNAVAILABLE', recovery(503)));
        }
      } else {
        let message = recovery(xhr.status);
        try {
          message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
        } catch {
          /* Use status message. */
        }
        reject(new RequestError(xhr.status, 'UPLOAD_FAILED', message));
      }
    };
    xhr.send(file);
  });
}
