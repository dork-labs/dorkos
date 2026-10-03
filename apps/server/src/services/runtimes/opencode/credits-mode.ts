/**
 * The half of OpenCode on DorkOS credits that asks the cloud: the live token
 * and the model list a sidecar boot or a turn runs on (ADR 261001-000811). The
 * plan it returns is built into a boot by `credits-sidecar.ts`; why credits are
 * a mode of the whole sidecar is told there.
 *
 * @module services/runtimes/opencode/credits-mode
 */
import {
  CreditsUnavailableError,
  creditsProtocolServed,
} from '../../core/cloud/credits-protocols.js';
import {
  creditsModels,
  heldCreditsToken,
  resolveCreditsLaunch,
} from '../../core/cloud/credits-inference.js';
import { OPENCODE_CAPABILITIES } from './runtime-constants.js';
import {
  OPENCODE_LABEL,
  OPENCODE_OWN_PLAN,
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
  const available = served ? ((await creditsModels())?.models ?? []) : [];
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
  const available = (await creditsModels())?.models ?? [];
  if (available.length === 0) throw new CreditsUnavailableError('unreachable', OPENCODE_LABEL);
  return { mode: 'credits', fingerprint: openCodeCreditsFingerprint(available), models: available };
}
