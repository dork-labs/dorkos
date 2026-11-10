/**
 * The window seat's early protected-file checks (DOR-4060), asked before the
 * permission gate so no level, card or saved "Always allow" reaches them:
 * `control_ui` opening a protected or hard-linked file on any canvas, and
 * `read_canvas_document` of a document whose file is one.
 *
 * The handlers ask the same rules again (`controlUi`, the room writer and
 * `readCanvasFileText`); this is the answer that comes first.
 *
 * @module services/session/browser-seat/protected-file-checks
 */
import { UiCommandSchema } from '@dorkos/shared/schemas';
import {
  canvasSourcePath,
  canvasSourceRefusal,
  peekCanvasService,
  sessionScope,
} from '../../canvas/index.js';
import { registerPreGateRefusal } from '../../core/capabilities/pre-gate-refusals.js';
import { protectedSourceRefusal } from '../../runtimes/shared/policy/protected-file-guard.js';
import { uiTurnFacts } from './ui-turn-facts.js';

/** Register the window seat's early checks. Idempotent. */
export function registerUiPreGateChecks(): void {
  registerPreGateRefusal('ui.control', (input, caller) => {
    const parsed = UiCommandSchema.safeParse(input);
    if (!parsed.success) return null;
    // The folder `controlUi` resolves a relative path in: the room turn's, else the session's.
    const roomCwd =
      caller.sessionId === undefined ? undefined : uiTurnFacts.read(caller.sessionId).roomTurn?.cwd;
    return canvasSourceRefusal(parsed.data, roomCwd ?? caller.cwd)?.message ?? null;
  });

  registerPreGateRefusal('ui.read_canvas_document', (input, caller) => {
    const documentId =
      typeof input === 'object' && input !== null
        ? (input as { documentId?: unknown }).documentId
        : undefined;
    const canvas = peekCanvasService();
    if (!canvas || caller.sessionId === undefined || typeof documentId !== 'string') return null;
    const scope = sessionScope(caller.sessionId);
    const document = canvas.get(scope, documentId);
    const source = document ? canvasSourcePath(document.content) : null;
    const tree = canvas.resolvedTreeOf(scope, documentId);
    if (source === null || tree === null) return null;
    return protectedSourceRefusal(source, tree)?.message ?? null;
  });
}
