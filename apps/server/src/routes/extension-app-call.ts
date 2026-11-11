/**
 * The server's half of one app calling another (DOR-3293, Security
 * 2026-11-10).
 *
 * The person's window makes the call for the calling app's frame and names
 * the caller in {@link CALLER_APP_HEADER}, a header the frame itself can never
 * set: a frame has no network, and the bridge builds every header. This
 * module checks that claim again against DorkOS's own records before the
 * target's routes see the request, with the same rule the bridge applies
 * ({@link decideAppCall}), and records every call with both ids.
 *
 * @module routes/extension-app-call
 */
import type { Context } from 'hono';
import {
  APP_ROUTE_METHODS,
  decideAppCall,
  type AppCallRefusal,
  type AppRouteMethod,
  type ExtensionManifest,
} from '@dorkos/extension-api';
import { recordAudit } from '../services/audit/audit-trail.js';
import type { ApiEnv } from '../http/api-chain.js';
import { EXTENSION_ID_HEADER } from './extension-write-binding.js';

/** The header naming the app a call came from. Only the host sets it. */
export const CALLER_APP_HEADER = 'x-dorkos-caller-app';

/** The code a refused call answers with. */
export const APP_CALL_REFUSED = 'app_call_refused';

/** What this check reads about each app, from the extension manager. */
export interface AppCallRecords {
  /** The app's manifest, or `undefined` when it is not installed. */
  manifest(id: string): ExtensionManifest | undefined;
  /** Whether the calling app's screens run right now. */
  callerRuns(id: string): boolean;
}

/** The sentence a refused call answers with, for the calling app's maker. */
const REFUSAL_TEXT: Record<AppCallRefusal | 'mismatch' | 'method', string> = {
  'not-declared': 'This app does not list that app in capabilities.http.apps.',
  self: 'An app calls its own routes without naming itself.',
  'target-unavailable': 'That app is not installed or not turned on.',
  'person-only': 'That route only answers its own app’s screens.',
  'not-exported': 'That app does not export this route.',
  'method-not-exported': 'That app does not export this method on this route.',
  'caller-not-listed': 'That route is exported to other apps only.',
  mismatch: 'The call named two different apps.',
  method: 'That method cannot be used between apps.',
};

/**
 * Decide a request to `targetId`'s routes that names a calling app.
 *
 * Answers `undefined` when the request names no other app (an app's own
 * call, or any other caller), so its routes see it as before. A request that
 * names one is passed on only when both manifests agree; anything else is
 * refused with 403 and recorded.
 *
 * @param c - The request.
 * @param targetId - The app whose routes were asked for.
 * @param targetRuns - Whether the target's server routes are running.
 * @param subPath - The path below the target's mount, as matched.
 * @param records - DorkOS's records of each app.
 * @returns The refusal to answer with, or `undefined` to go on.
 */
export function refusedAppCall(
  c: Context<ApiEnv>,
  targetId: string,
  targetRuns: boolean,
  subPath: string,
  records: AppCallRecords
): Response | undefined {
  const named = c.req.header(CALLER_APP_HEADER);
  const stamp = c.req.header(EXTENSION_ID_HEADER);
  // An app's own call may carry its stamp, and a caller header naming itself
  // adds nothing; both go on as an own call.
  const callerId = named ?? (stamp !== undefined && stamp !== targetId ? stamp : undefined);
  if (callerId === undefined || callerId === targetId) {
    return stamp !== undefined && named !== undefined && stamp !== named
      ? refuse(c, targetId, named, 'mismatch')
      : undefined;
  }
  if (stamp !== undefined && stamp !== callerId) return refuse(c, targetId, callerId, 'mismatch');
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  if (!(APP_ROUTE_METHODS as readonly string[]).includes(method)) {
    return refuse(c, targetId, callerId, 'method');
  }
  const caller = records.callerRuns(callerId) ? records.manifest(callerId) : undefined;
  if (!caller) return refuse(c, targetId, callerId, 'not-declared');
  const path = decodedPath(subPath);
  if (path === null) return refuse(c, targetId, callerId, 'not-exported');
  const target = targetRuns ? (records.manifest(targetId) ?? null) : null;
  const decision = decideAppCall({
    caller,
    target,
    targetId,
    method: method as AppRouteMethod,
    path,
  });
  audit(targetId, target?.name ?? targetId, caller.id, caller.name, method, path, decision);
  return decision.ok ? undefined : refuse(c, targetId, callerId, decision.reason, false);
}

/** The path below the mount with each segment decoded, or `null` when one will not decode. */
function decodedPath(subPath: string): string | null {
  try {
    return subPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }
}

/** Answer a refused call, recording it unless it was already recorded. */
function refuse(
  c: Context<ApiEnv>,
  targetId: string,
  callerId: string,
  reason: keyof typeof REFUSAL_TEXT,
  record = true
): Response {
  if (record) {
    audit(targetId, targetId, callerId, callerId, c.req.method, '', {
      ok: false,
      reason: reason as AppCallRefusal,
    });
  }
  return c.json({ error: REFUSAL_TEXT[reason], code: APP_CALL_REFUSED, reason }, 403);
}

/** Record one call between apps, allowed or refused, with both ids. */
function audit(
  targetId: string,
  targetName: string,
  callerId: string,
  callerName: string,
  method: string,
  path: string,
  decision: { ok: true } | { ok: false; reason: string }
): void {
  recordAudit({
    action: 'extension.app_call',
    operation: method === 'GET' ? 'access' : 'modify',
    outcome: decision.ok ? 'ok' : 'refused',
    target: { type: 'extension', id: targetId, name: targetName },
    change: [
      { field: 'callerApp', after: callerId },
      { field: 'method', after: method },
      ...(path ? [{ field: 'path', after: path }] : []),
    ],
    summary: decision.ok
      ? `${callerName} called ${targetName}`
      : `${callerName} was refused a call to ${targetName}`,
    ...(decision.ok ? {} : { error: decision.reason }),
  });
}
