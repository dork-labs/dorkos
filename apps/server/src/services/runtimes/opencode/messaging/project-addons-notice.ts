/**
 * The once-per-chat notice that a project's own OpenCode add-ons are off
 * (DOR-4404).
 *
 * The shared sidecar loads no project's config or code (DOR-4394), and nothing
 * should be lost silently. So the first turn of a chat whose project has
 * plugins, tools or MCP servers of its own says how many DorkOS kept off. The
 * event carries counts only, from DorkOS's own count of what it withheld
 * (`withheld-project-addons.ts`), never any text the project wrote.
 *
 * Once per chat, across restarts: a chat whose durable record already holds
 * the notice is not told again. The in-memory set saves that read on every
 * later turn.
 *
 * @module services/runtimes/opencode/messaging/project-addons-notice
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { getSessionEventStore } from '../../../session/session-state-projector.js';
import { withheldProjectAddons } from './withheld-project-addons.js';

/** Chats already told, or already found told in the record. */
const told = new Set<string>();

/** The most chats remembered before the oldest is forgotten (the record still answers). */
const TOLD_KEPT = 1_000;

/** Remember a chat as told, forgetting the oldest past the cap. */
function markTold(sessionId: string): void {
  told.add(sessionId);
  if (told.size > TOLD_KEPT) told.delete(told.values().next().value!);
}

/**
 * Yield the notice for this chat's turn, when it is owed.
 *
 * Never throws: a project DorkOS cannot read, or a record it cannot read,
 * costs the notice and nothing else.
 *
 * @param sessionId - The DorkOS session id the notice is recorded under.
 * @param directory - The session's folder.
 */
export function* projectAddonsNotice(sessionId: string, directory: string): Generator<StreamEvent> {
  if (told.has(sessionId)) return;
  let counts;
  try {
    if ((getSessionEventStore()?.readProjectAddonsOff(sessionId).length ?? 0) > 0) {
      markTold(sessionId);
      return;
    }
    counts = withheldProjectAddons(directory);
  } catch {
    return;
  }
  if (counts === undefined) return;
  markTold(sessionId);
  yield { type: 'project_addons_off', data: counts };
}

/**
 * Forget every chat told, for tests.
 *
 * @internal
 */
export function resetProjectAddonsNotice(): void {
  told.clear();
}
