/**
 * The operator's own name, as they asked to be called (DOR-899, DOR-2458).
 *
 * `config.profile.displayName` ("what the user likes to be called", spec
 * `user-profile-onboarding`) is the only place a real human name for the
 * operator is stored on this machine — NOT the room author registry's
 * `displayName` for the same person, which `bindOwner` fixes at `'You'` on
 * purpose: the right word from the operator's own seat in the app, and the
 * wrong one anywhere else. A bridged group sees this name on the operator's
 * posts, a commit a person makes is authored under it, and an agent's room
 * context names the operator by it.
 *
 * `sanitizeIdentity` runs the same label treatment every other agent-writable
 * profile value gets before it reaches a line DorkOS wrote: `config_patch` can
 * set this field mid-conversation, so it is not purely operator-authored text.
 *
 * @module server/services/core/config/operator-display-name
 */
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';

/**
 * The operator's profile name, sanitized, or `null` when they have not given
 * one (or it sanitizes away to nothing). Read per call, never captured: the
 * person can change it at any time.
 *
 * **Never throws.** It is read on a room turn's path, and a name that cannot be
 * read is not a reason for a person's question to go unanswered: the caller
 * falls back to "the operator", which is true either way.
 */
export function readOperatorDisplayName(): string | null {
  let raw: string | null | undefined;
  try {
    raw = configManager.get('profile')?.displayName;
  } catch (err) {
    logger.debug('[profile] could not read the operator’s name; using the fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!raw) return null;
  return sanitizeIdentity(raw) ?? null;
}
