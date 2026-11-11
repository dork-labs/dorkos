/**
 * The bridge's half of one app calling another (DOR-3293): the same rule the
 * server applies, checked here first so a refused call never leaves the window,
 * and the caller token each frame load is given, which is how the server knows
 * which app is calling.
 *
 * @module features/extensions/frame/app-call
 */
import {
  decideAppCall,
  type AppCallRefusal,
  type AppRouteMethod,
  type ExtensionManifest,
} from '@dorkos/extension-api';
import { extensionApiUrl } from '../model/extension-api-url';
import { extensionRequestPath, readAppResponse } from './app-request';
import { runningAppManifest } from './running-apps';

/** What the calling app's maker reads when a call is refused. */
const REFUSAL_TEXT: Record<AppCallRefusal, string> = {
  'not-declared': 'List that app in capabilities.http.apps first.',
  self: 'Call your own routes without naming your app.',
  'target-unavailable': 'That app is not installed or not turned on.',
  'person-only': 'That route only answers its own app’s screens.',
  'not-exported': 'That app does not export this route.',
  'method-not-exported': 'That app does not export this method on this route.',
  'caller-not-listed': 'That route is exported to other apps only.',
};

/**
 * Refuse a call to another app's route unless both manifests allow it.
 *
 * @param caller - The calling app's manifest, from DorkOS's records.
 * @param targetId - The app it asked to call.
 * @param method - The method it asked for.
 * @param path - The path it asked for, as it wrote it.
 * @throws When the call is not allowed, naming why.
 */
export function assertAppCall(
  caller: ExtensionManifest,
  targetId: string,
  method: AppRouteMethod,
  path: string
): void {
  const decision = decideAppCall({
    caller,
    target: runningAppManifest(targetId),
    targetId,
    method,
    path,
  });
  if (!decision.ok) throw new Error(REFUSAL_TEXT[decision.reason]);
}

/** What the server answers for a caller token it no longer knows. */
const TOKEN_INVALID = 'caller_token_invalid';

/**
 * Make calls to other apps for one frame load of one app.
 *
 * The first call asks the server for this frame load's caller token; later
 * calls reuse it. A token the server has forgotten (idle too long, or the
 * session changed) is asked for again once.
 *
 * @param caller - The calling app's manifest, from DorkOS's records.
 * @returns A function that makes one call to another app's route.
 */
export function createAppCaller(caller: ExtensionManifest) {
  let token: Promise<string> | null = null;
  const callerToken = (): Promise<string> =>
    (token ??= fetch(extensionApiUrl('/extension-frame/caller-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: caller.id }),
    }).then(async (response) => {
      if (!response.ok) throw new Error('This app cannot call other apps right now.');
      return ((await response.json()) as { token: string }).token;
    })).catch((err: unknown) => {
      token = null;
      throw err;
    });

  return async function callApp(
    targetId: string,
    method: AppRouteMethod,
    path: string,
    body: unknown
  ): Promise<unknown> {
    const address = extensionRequestPath(targetId, path);
    assertAppCall(caller, targetId, method, path);
    const send = async () =>
      fetch(extensionApiUrl(address), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-DorkOS-Extension': caller.id,
          // Both set by the host alone: the frame never builds a header.
          'X-DorkOS-Caller-App': caller.id,
          'X-DorkOS-Caller-Token': await callerToken(),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    let response = await send();
    if (response.status === 403 && (await isTokenRefusal(response.clone()))) {
      token = null;
      response = await send();
    }
    return readAppResponse(response);
  };
}

/** Whether a refusal says the caller token is no longer known. */
async function isTokenRefusal(response: Response): Promise<boolean> {
  try {
    return ((await response.json()) as { code?: unknown }).code === TOKEN_INVALID;
  } catch {
    return false;
  }
}
