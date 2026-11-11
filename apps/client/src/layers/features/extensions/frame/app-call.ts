/**
 * The bridge's half of one app calling another (DOR-3293): the same rule the
 * server applies, checked here first so a refused call never leaves the window.
 *
 * @module features/extensions/frame/app-call
 */
import {
  decideAppCall,
  type AppCallRefusal,
  type AppRouteMethod,
  type ExtensionManifest,
} from '@dorkos/extension-api';
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
