import {
  OPENCODE_CREDITS_PROVIDER_ID,
  OPENCODE_LABEL,
  creditsModelFor,
  type OpenCodeSidecarPlan,
} from './credits-sidecar.js';
import { CreditsUnavailableError } from '../../core/cloud/credits-protocols.js';

/**
 * The credits model id a session's OpenCode selection names: the id after the
 * credits provider's prefix, or the selection as stored when it names another
 * provider (which credits never serve), or `undefined` for none.
 *
 * @param selected - The session's model setting (`provider/model`), if any.
 */
export function creditsModelIdOf(selected: string | undefined): string | undefined {
  const prefix = `${OPENCODE_CREDITS_PROVIDER_ID}/`;
  return selected?.startsWith(prefix) ? selected.slice(prefix.length) : selected;
}

/**
 * The OpenCode selection (`provider/model`) for one credits model id.
 *
 * @param id - A credits model id.
 */
export function creditsSelection(id: string): string {
  return `${OPENCODE_CREDITS_PROVIDER_ID}/${id}`;
}

/**
 * The `{providerID, modelID}` a credits turn sends: the session's model when it
 * is one of the credits models, else the default one.
 *
 * @param selected - The session's model setting.
 * @param plan - The credits plan the sidecar runs on.
 * @throws {CreditsUnavailableError} When the plan has no model at all.
 */
export function creditsPromptModel(
  selected: string | undefined,
  plan: OpenCodeSidecarPlan
): { providerID: string; modelID: string } {
  const modelID = creditsModelFor(selected, plan.models);
  if (modelID === null) throw new CreditsUnavailableError('unreachable', OPENCODE_LABEL);
  return { providerID: OPENCODE_CREDITS_PROVIDER_ID, modelID };
}
