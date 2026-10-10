/**
 * The half of OpenCode on DorkOS credits that asks the cloud: the live token
 * and the model list a sidecar boot or a turn runs on (ADR 261001-000811). The
 * list is the one credits list (`credits-models.ts`), in OpenCode's chat format
 * once the service says which formats its models are in. The
 * plan it returns is built into a boot by `credits-sidecar.ts`; why credits are
 * a mode of the whole sidecar is told there. It also maps a session's model
 * setting to and from the credits provider's ids.
 *
 * @module services/runtimes/opencode/credits-mode
 */
import {
  CreditsUnavailableError,
  creditsProtocolServed,
} from '../../core/cloud/credits-protocols.js';
import { heldCreditsToken, resolveCreditsLaunch } from '../../core/cloud/credits-inference.js';
import { creditsModelsFor } from '../../core/cloud/credits-models.js';
import { OPENCODE_CAPABILITIES } from './runtime-constants.js';
import {
  OPENCODE_CREDITS_PROVIDER_ID,
  OPENCODE_LABEL,
  OPENCODE_OWN_PLAN,
  creditsModelFor,
  openCodeCreditsFingerprint,
  openCodeRunsOnCredits,
  type OpenCodeSidecarPlan,
} from './credits-sidecar.js';

/**
 * What the sidecar should boot on now, for a boot nobody is waiting to send a
 * turn through (a session list, a history read). Never mints and never
 * throws: on credits it lists the models only while the held token serves the
 * chat format, and otherwise plans a sidecar that can pay for nothing, which
 * is the fail-closed shape — it never falls back to the person's own
 * providers.
 */
export async function planOpenCodeSidecar(): Promise<OpenCodeSidecarPlan> {
  if (!openCodeRunsOnCredits()) return OPENCODE_OWN_PLAN;
  const token = heldCreditsToken();
  const served = token !== null && creditsProtocolServed('openai-chat-completions', token);
  const available = served ? await creditsModelsFor('openai-chat-completions') : [];
  return { mode: 'credits', fingerprint: openCodeCreditsFingerprint(available), models: available };
}

/**
 * What the sidecar must run on for a turn about to be sent: the person's own
 * sign-in, or credits that can pay right now (a live token serving the chat
 * format) with at least one model. The relay checks again for every request.
 *
 * @throws {CreditsUnavailableError} On credits, when credits cannot pay for it.
 */
export async function planOpenCodeTurn(): Promise<OpenCodeSidecarPlan> {
  if (!openCodeRunsOnCredits()) return OPENCODE_OWN_PLAN;
  await resolveCreditsLaunch(OPENCODE_CAPABILITIES, OPENCODE_LABEL);
  const available = await creditsModelsFor('openai-chat-completions');
  if (available.length === 0) throw new CreditsUnavailableError('unreachable', OPENCODE_LABEL);
  return { mode: 'credits', fingerprint: openCodeCreditsFingerprint(available), models: available };
}

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
