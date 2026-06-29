/**
 * Generated-content side table for projection actions.
 *
 * The {@link ProjectionAction} contract is locked and intentionally carries no
 * payload bytes — it describes *what* to project, not the exact file content.
 * `scaffold` and `generate` actions, however, need deterministic bytes to write.
 * Rather than widen the locked type, the projector attaches those bytes here,
 * keyed by the action's object identity, and the apply/check stages read them
 * back. Identity is preserved as long as the same plan object flows from
 * `buildPlan` into `applyPlan`/`checkPlan` (the in-process v1 contract); a plan
 * serialized to JSON and back loses this association by design.
 *
 * @module plan/content-map
 */
import type { ProjectionAction } from './types.js';

const ACTION_CONTENT = new WeakMap<ProjectionAction, string>();

/**
 * Attach the exact bytes a `scaffold`/`generate` action will write.
 *
 * @param action - the projection action to annotate.
 * @param content - the deterministic file content the action produces.
 */
export function setActionContent(action: ProjectionAction, content: string): void {
  ACTION_CONTENT.set(action, content);
}

/**
 * Read the bytes previously attached to a `scaffold`/`generate` action.
 *
 * @param action - the projection action to look up.
 * @returns the attached content, or `undefined` if none was attached.
 */
export function getActionContent(action: ProjectionAction): string | undefined {
  return ACTION_CONTENT.get(action);
}
