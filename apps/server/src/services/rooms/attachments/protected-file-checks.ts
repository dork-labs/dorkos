/**
 * The rooms domain's early protected-file checks (DOR-4060), asked before the
 * permission gate so no level, card or saved "Always allow" reaches them:
 * `post_to_room` naming a protected or hard-linked file as an attachment, and
 * `read_canvas` of a document whose file is one.
 *
 * The handlers ask the same rules again when they read (`readOwnFile`,
 * `readCanvasFileText`); this is the answer that comes first.
 *
 * @module services/rooms/attachments/protected-file-checks
 */
import { canvasSourcePath } from '../../canvas/index.js';
import { registerPreGateRefusal } from '../../core/capabilities/pre-gate-refusals.js';
import { protectedSourceRefusal } from '../../runtimes/shared/policy/protected-file-guard.js';
import { getRoomService } from '../index.js';

/** A string field off an unknown input, or `undefined`. */
function field(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

/** Register the rooms domain's early checks. Idempotent. */
export function registerRoomPreGateChecks(): void {
  registerPreGateRefusal('rooms.post', (input, caller) => {
    const attachments = field(input, 'attachments');
    if (!Array.isArray(attachments) || caller.cwd === undefined) return null;
    for (const named of attachments) {
      if (typeof named !== 'string') continue;
      const refused = protectedSourceRefusal(named, caller.cwd);
      if (refused) return refused.message;
    }
    return null;
  });

  registerPreGateRefusal('rooms.read_canvas', (input) => {
    const roomId = field(input, 'roomId');
    const documentId = field(input, 'documentId');
    if (typeof roomId !== 'string' || typeof documentId !== 'string') return null;
    const canvas = getRoomService().canvas;
    const document = canvas.get(roomId, documentId);
    const source = document ? canvasSourcePath(document.content) : null;
    const tree = canvas.resolvedTreeOf(roomId, documentId);
    if (source === null || tree === null) return null;
    return protectedSourceRefusal(source, tree)?.message ?? null;
  });
}
