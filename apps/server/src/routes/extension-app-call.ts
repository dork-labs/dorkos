/**
 * The server's half of one app calling another (DOR-3293, Security
 * 2026-11-10).
 *
 * The person's window makes the call for the calling app's frame, carrying
 * the caller token that frame load was given (`extension-caller-token.ts`).
 * The server reads the calling app from its own record of that token; a
 * header naming an app ({@link CALLER_APP_HEADER}, or the extension stamp
 * naming another app) counts for nothing without one, and an agent or an API
 * key that sends either is refused. The call is then checked against both
 * manifests with the same rule the bridge applies ({@link decideAppCall}),
 * and every call is recorded with both ids.
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
import { honoRequestFacts } from '../http/request-facts.js';
import {
  CALLER_TOKEN_HEADER,
  CALLER_TOKEN_INVALID,
  isNotAWindow,
  resolveCallerToken,
} from './extension-caller-token.js';
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

/** Why a call was refused before the manifests were read. */
type CallerRefusal = 'mismatch' | 'method' | 'no-token' | 'not-a-window';

/** The sentence a refused call answers with, for the calling app's maker. */
const REFUSAL_TEXT: Record<AppCallRefusal | CallerRefusal, string> = {
  'not-declared': 'This app does not list that app in capabilities.http.apps.',
  self: 'An app calls its own routes without naming itself.',
  'target-unavailable': 'That app is not installed or not turned on.',
  'person-only': 'That route only answers its own app’s screens.',
  'not-exported': 'That app does not export this route.',
  'method-not-exported': 'That app does not export this method on this route.',
  'caller-not-listed': 'That route is exported to other apps only.',
  mismatch: 'The call named two different apps.',
  method: 'That method cannot be used between apps.',
  'no-token': 'A call between apps must come from the app’s own frame.',
  'not-a-window': 'Only a person’s DorkOS window calls between apps.',
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
  const token = c.req.header(CALLER_TOKEN_HEADER);
  const named = c.req.header(CALLER_APP_HEADER);
  const stamp = c.req.header(EXTENSION_ID_HEADER);
  const claimed = named ?? (stamp !== undefined && stamp !== targetId ? stamp : undefined);
  // No token and no app named: an app's own call, or any other caller, as before.
  if (token === undefined && (claimed === undefined || claimed === targetId)) return undefined;
  const facts = honoRequestFacts(c);
  if (isNotAWindow(facts)) return refuse(c, targetId, claimed ?? 'unknown', 'not-a-window');
  // A header naming an app counts for nothing on its own.
  if (token === undefined) return refuse(c, targetId, claimed!, 'no-token');
  const callerId = resolveCallerToken(token, facts);
  if (callerId === null) {
    return c.json(
      { error: 'Ask for a new caller token.', code: CALLER_TOKEN_INVALID, reason: 'token' },
      403
    );
  }
  if ((named !== undefined && named !== callerId) || (stamp !== undefined && stamp !== callerId)) {
    return refuse(c, targetId, callerId, 'mismatch');
  }
  // A frame calling its own app's routes with its token is an own call.
  if (callerId === targetId) return undefined;
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

/**
 * The path below the mount with each segment decoded, or `null` when one will
 * not decode, or decodes to hold a `/` or `\`. The target's routes see the raw
 * path, so `a%2Fb` must never be judged as the two segments `a` and `b`: it
 * could match a deeper exported route while reaching another (Security, Nov 12).
 */
function decodedPath(subPath: string): string | null {
  try {
    const segments = subPath.split('/').map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment.includes('/') || segment.includes('\\'))) return null;
    return segments.join('/');
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
