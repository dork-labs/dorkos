/**
 * `session_start`'s early check (DOR-4060): before the permission gate, so no
 * level, card or saved "Always allow" starts a chat in a protected folder. The
 * handler asks the same rule again.
 *
 * @module services/session/launch/session-start-pre-gate
 */
import path from 'node:path';
import { registerPreGateRefusal } from '../../core/capabilities/pre-gate-refusals.js';
import { isProtectedLaunchFolder, PROTECTED_FOLDER_MESSAGE } from './launch-caller.js';

/** Register the check. Idempotent. */
export function registerSessionStartPreGate(): void {
  registerPreGateRefusal('session_start', (input, caller) => {
    const cwd =
      typeof input === 'object' && input !== null ? (input as { cwd?: unknown }).cwd : null;
    return typeof cwd === 'string' &&
      path.isAbsolute(cwd) &&
      isProtectedLaunchFolder(cwd, caller.agentPath)
      ? PROTECTED_FOLDER_MESSAGE
      : null;
  });
}
