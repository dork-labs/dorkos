import type { AgentSession } from '../../agent-types.js';
/** Persist a native rename before SDK publication, retaining mandatory identity failures. */
import { RequiredSessionIdentityError } from '../../../../../lib/replay/required-session-identity-error.js';
import { logger } from '../../../../../lib/logger.js';

/** Server-only ownership observation; absent from tool and HTTP contracts. */
export type NativeIdentityOwnerGuard = () => boolean;
interface NativeRekeySettings {
  rekeySessionSettings(from: string, to: string, owner?: NativeIdentityOwnerGuard): Promise<void>;
}

/** Optional settings loss keeps legacy streaming; a required billing constraint cannot be lost. */
export async function persistSdkSessionRebind(
  settings: NativeRekeySettings | undefined,
  previousSdkSessionId: string,
  nextSdkSessionId: string,
  owner?: NativeIdentityOwnerGuard
): Promise<void> {
  try {
    await settings?.rekeySessionSettings(previousSdkSessionId, nextSdkSessionId, owner);
  } catch (error) {
    if (error instanceof RequiredSessionIdentityError) throw error;
    logger.warn('[rebindSdkSession] settings re-key failed; row stays under the previous id', {
      previousSdkSessionId,
      nextSdkSessionId,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Preserve the exact live producer; private maps never become a public runtime API. */
export async function rebindOwnedSdkSession(
  settings: NativeRekeySettings | undefined,
  previous: string,
  next: string,
  state: {
    key: string | undefined;
    sessions: ReadonlyMap<string, AgentSession>;
    indexes: Map<string, string>;
    refusals: WeakMap<AgentSession, RequiredSessionIdentityError>;
    producer?: AgentSession;
  }
): Promise<void> {
  const { key, sessions, indexes, refusals } = state;
  const original = state.producer ?? (key ? sessions.get(key) : undefined);
  const refused = original && refusals.get(original);
  if (refused) {
    // Another init may have mutated this already-refused producer again.
    if (original && key && sessions.get(key) === original) original.sdkSessionId = previous;
    throw refused;
  }
  if (previous === next) return;
  const ownsOriginal = () => !!original && sessions.get(key!) === original;
  const stillOwned = () => {
    const target = sessions.get(next) ?? sessions.get(indexes.get(next) ?? '');
    return ownsOriginal() && (target === undefined || target === original);
  };
  const refuse = (error: RequiredSessionIdentityError) => {
    if (original) {
      refusals.set(original, error);
      if (ownsOriginal()) original.sdkSessionId = previous;
    }
  };
  // Only the actual producer is a trustworthy mandatory native witness. Legacy
  // ordinary calls may still omit it after Registry positively proves no constraint.
  const requiredOwner = () => state.producer !== undefined && stillOwned();
  try {
    await persistSdkSessionRebind(settings, previous, next, requiredOwner);
  } catch (error) {
    if (error instanceof RequiredSessionIdentityError) refuse(error);
    throw error;
  }
  // The await may have evicted/replaced the owner or admitted an independent target.
  if (original && !stillOwned()) {
    const error = new RequiredSessionIdentityError('Live native identity ownership changed.');
    refuse(error);
    throw error;
  }
  if (key && ownsOriginal()) {
    indexes.set(previous, key);
    indexes.set(next, key);
  } else {
    logger.warn('[rebindSdkSession] no live session for rebind; indexed nothing', {
      previousSdkSessionId: previous,
      nextSdkSessionId: next,
    });
  }
}
