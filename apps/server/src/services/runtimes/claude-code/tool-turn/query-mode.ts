/** Mode controls belong to the SDK process, including between two logical turns on it. */
import type { PermissionUpdate, Query } from '@anthropic-ai/claude-agent-sdk';
import { sessionScopedMode } from '../turn-permission.js';
import type { ControlAck } from '../sessions/bounded-control.js';
import type { LaunchFingerprint } from '../sessions/launch-fingerprint.js';

type NativeMode = NonNullable<LaunchFingerprint['live']['permissionMode']>;
type ModeChange =
  | { kind: 'pending' | 'unknown' }
  | { kind: 'applied'; permissionMode: string; sdkPermissionMode: NativeMode };
const changes = new WeakMap<Query, ModeChange>();

/** Read the last observation of a person's live control on this exact query. */
export function queryModeChange(query: Query) {
  return changes.get(query);
}

/** A permission response can contain a mode update, but the SDK does not acknowledge its delivery. */
function markQueryModeUnknown(query: Query) {
  changes.set(query, { kind: 'unknown' });
}

/** Forwarded SDK suggestions have no acknowledgement, even a suggestion the chat already stores. */
export function observeSuggestedMode(query: Query | undefined, suggestions: PermissionUpdate[]) {
  if (query && suggestions.some((update) => update.type === 'setMode')) markQueryModeUnknown(query);
  return sessionScopedMode(suggestions);
}

/** Track the existing SDK acknowledgement without inferring the order of overlapping writes. */
export function observeQueryModeChange(
  query: Query,
  permissionMode: string,
  sdkPermissionMode: NativeMode
) {
  const prior = changes.get(query);
  const pending: ModeChange = { kind: prior && prior.kind !== 'applied' ? 'unknown' : 'pending' };
  changes.set(query, pending);
  return (ack: ControlAck) => {
    if (changes.get(query) !== pending || pending.kind !== 'pending') return;
    if (ack === 'acked') changes.set(query, { kind: 'applied', permissionMode, sdkPermissionMode });
    else if (ack === 'unacked') markQueryModeUnknown(query);
    // A settled refusal did not change an otherwise known query.
    else if (prior) changes.set(query, prior);
    else changes.delete(query);
  };
}

/** Before reuse, carry any acknowledged mid-turn control into the process's launch fingerprint. */
export function reconcileQueryMode(bundle: {
  live: Query | undefined;
  fingerprint: LaunchFingerprint | undefined;
}): boolean {
  const { live, fingerprint } = bundle;
  if (!live || !fingerprint) return true;
  const observed = changes.get(live);
  if (!observed) return true;
  if (observed.kind !== 'applied') return false;
  bundle.fingerprint = {
    ...fingerprint,
    live: { ...fingerprint.live, permissionMode: observed.sdkPermissionMode },
  };
  changes.delete(live);
  return true;
}
