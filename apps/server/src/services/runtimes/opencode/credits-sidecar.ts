/**
 * OpenCode on DorkOS credits (ADR 261001-000811): what the sidecar runs on, and
 * the config and environment that make the credits endpoint the only place a
 * turn can go.
 *
 * ## One choice for the whole runtime
 *
 * OpenCode runs every session through ONE managed `opencode serve` sidecar
 * (ADR-0308). So credits are a MODE of the sidecar,
 * chosen by OpenCode's recorded Runs on default (the same record "Use credits
 * for" switches): on credits, the sidecar is booted with the credits provider
 * and nothing else; on the person's own sign-in, with their own provider and
 * no credits variable at all. Changing the choice recycles the sidecar.
 *
 * That is also how OpenCode's power source already behaves (a new key
 * recycles the sidecar), so credits are one more power source. A conversation
 * started on one side continues on the other after a switch; that is the
 * person's choice to make, and DorkOS never makes it for them.
 *
 * ## Why a project cannot redirect or replace the credits provider
 *
 * - `enabled_providers: ["dorkos-credits"]` leaves the credits provider as the
 *   only one OpenCode will route to, whatever keys the environment or the
 *   person's own auth store hold.
 * - The config arrives as `OPENCODE_CONFIG_CONTENT`, which OpenCode merges
 *   after every global and project config file, so the endpoint, the
 *   provider package, the default models and the provider allow list all
 *   outrank a project's `opencode.json` (proved against the installed binary,
 *   `credits-mode.binary.test.ts`).
 * - **The token never enters the sidecar at all.** The credits provider points
 *   at the DorkOS credits relay (`core/cloud/credits-relay.ts`, loopback only)
 *   with a key drawn fresh for every boot, and the relay adds the real token
 *   on the way out. OpenCode substitutes `{env:…}` and `{file:…}` in a
 *   project's own `opencode.json` and can send the result to a remote MCP
 *   server, so anything secret in this process could leave the machine with
 *   no code run (on Linux, `{file:/proc/self/environ}` is the whole
 *   environment). What a project can reach this way is the relay key, which
 *   opens nothing off this machine and dies with the boot.
 *
 * What it does not protect against: code the sidecar runs for a project on
 * credits (its plugins, its tools) can use the relay key from this machine
 * while the boot lasts, as it could the person's own key on their own sign-in.
 *
 * Models are not known to OpenCode for a custom provider, so the credits
 * provider is given the list the service publishes for this link
 * (`GET /v1/inference/models`). A turn picks the session's model when it is
 * one of those, else the first one that can call tools, else the first.
 *
 * This module is the pure half (the plan, the config, the environment), so the
 * sidecar manager can build a boot from it without loading the cloud client;
 * `credits-mode.ts` is the half that asks the cloud whether credits can pay
 * and for the models.
 *
 * @module services/runtimes/opencode/credits-sidecar
 */
import type { InferenceModel } from '@dork-labs/cloud-api';
import { CreditsUnavailableError, isCreditsTokenVar } from '../../core/cloud/credits-protocols.js';
import { creditsIsDefaultFor } from '../../core/cloud/credits-defaults.js';

/** The provider id the credits provider is registered under. */
export const OPENCODE_CREDITS_PROVIDER_ID = 'dorkos-credits';

/** The provider package OpenCode loads for the chat-completions format (bundled with OpenCode). */
const CHAT_COMPLETIONS_PACKAGE = '@ai-sdk/openai-compatible';

/** This runtime's name, as a refusal sentence says it. */
export const OPENCODE_LABEL = 'OpenCode';

/** Which side the sidecar runs on. */
export type OpenCodeSidecarMode = 'own' | 'credits';

/** Whether OpenCode's recorded Runs on default is DorkOS credits. */
export function openCodeRunsOnCredits(): boolean {
  return creditsIsDefaultFor('opencode');
}

/**
 * The provider names a credits sidecar never takes from the person's
 * environment: the keys and endpoint OpenCode's own profile carries. With
 * `enabled_providers` pinned none of them could be routed to anyway; leaving
 * them out also keeps them away from a project on credits.
 */
const PERSON_PROVIDER_NAMES = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_BASE_URL',
]);

/**
 * The sidecar environment on credits: the projected environment minus the
 * person's provider keys and endpoint and any credits token. Nothing in it
 * can pay: the relay key rides the config, and the token stays in DorkOS.
 *
 * @param projected - The environment `runtimeEnvironment` built for the sidecar.
 */
export function openCodeCreditsEnv(
  projected: Readonly<Record<string, string>>
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (!PERSON_PROVIDER_NAMES.has(name) && !isCreditsTokenVar(name)) kept[name] = value;
  }
  return kept;
}

/** Where a credits sidecar's provider points, and the key it presents there. */
export interface OpenCodeRelayGrant {
  /** The relay's base URL for the chat-completions format. */
  baseUrl: string;
  /** This boot's relay key. Opens nothing off this machine. */
  key: string;
}

/**
 * The model a credits turn runs on: the session's when it names one of the
 * credits models, else the first that can call tools, else the first.
 *
 * @param selected - The session's model setting (`provider/model`), if any.
 * @param available - The credits models.
 * @returns The model id, or `null` when there are none.
 */
export function creditsModelFor(
  selected: string | undefined,
  available: readonly InferenceModel[]
): string | null {
  const prefix = `${OPENCODE_CREDITS_PROVIDER_ID}/`;
  if (selected?.startsWith(prefix)) {
    const id = selected.slice(prefix.length);
    if (available.some((model) => model.id === id)) return id;
  }
  return (available.find((model) => model.supports.tools) ?? available[0])?.id ?? null;
}

/**
 * The config a credits sidecar merges last: the credits provider as the only
 * one enabled, pointed at the relay with this boot's key, its models and the
 * default ones. With no relay grant or no models, the allow list alone, so
 * nothing can run.
 *
 * @param relay - This boot's relay grant, or `null` when credits cannot pay.
 * @param available - The credits models.
 */
export function openCodeCreditsConfig(
  relay: OpenCodeRelayGrant | null,
  available: readonly InferenceModel[]
): Record<string, unknown> {
  const pinned = { enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID] };
  const fallback = creditsModelFor(undefined, available);
  if (relay === null || fallback === null) return pinned;
  const modelRef = `${OPENCODE_CREDITS_PROVIDER_ID}/${fallback}`;
  return {
    ...pinned,
    model: modelRef,
    small_model: modelRef,
    provider: {
      [OPENCODE_CREDITS_PROVIDER_ID]: {
        name: 'DorkOS credits',
        npm: CHAT_COMPLETIONS_PACKAGE,
        // `includeUsage` asks for usage on streamed answers, so every turn is
        // metered from what the endpoint itself reports.
        options: {
          baseURL: relay.baseUrl,
          apiKey: relay.key,
          includeUsage: true,
        },
        models: Object.fromEntries(
          available.map((model) => [
            model.id,
            {
              name: model.displayName,
              tool_call: model.supports.tools,
              reasoning: model.supports.thinking,
              limit: { context: model.contextWindow, output: model.maxOutputTokens },
            },
          ])
        ),
      },
    },
  };
}

/** What one sidecar boot runs on. Carries no credential: the token stays in DorkOS. */
export interface OpenCodeSidecarPlan {
  /** Which side. */
  mode: OpenCodeSidecarMode;
  /** What identifies this plan: two plans with the same fingerprint boot the same sidecar. */
  fingerprint: string;
  /** The credits models, on credits when credits can pay; else empty. */
  models: InferenceModel[];
}

/**
 * The fingerprint of a credits plan: its model list. The token is not part of
 * it, because the sidecar never holds one: a new token reaches every request
 * through the relay without a restart.
 *
 * @param available - The credits models.
 */
export function openCodeCreditsFingerprint(available: readonly InferenceModel[]): string {
  return available.length === 0
    ? 'credits:none'
    : `credits:${available.map((model) => model.id).join(',')}`;
}

/** The plan for the person's own sign-in: no credits variable, no credits provider. */
export const OPENCODE_OWN_PLAN: OpenCodeSidecarPlan = {
  mode: 'own',
  fingerprint: 'own',
  models: [],
};

/**
 * What a sidecar boot runs on when nothing that can reach the cloud was
 * installed to plan it: the person's own sign-in, or, when OpenCode's choice is
 * credits, a credits sidecar that can pay for nothing. Never the person's own
 * providers for a person who chose credits.
 *
 * @param runsOnCredits - Whether OpenCode's recorded choice is credits.
 */
export async function planSidecarWithoutCloud(
  runsOnCredits: () => boolean = openCodeRunsOnCredits
): Promise<OpenCodeSidecarPlan> {
  return runsOnCredits()
    ? { mode: 'credits', fingerprint: openCodeCreditsFingerprint([]), models: [] }
    : OPENCODE_OWN_PLAN;
}

/**
 * What a turn runs on when nothing that can reach the cloud was installed to
 * plan it: the person's own sign-in, or a refusal when they chose credits.
 *
 * @param runsOnCredits - Whether OpenCode's recorded choice is credits.
 * @throws {CreditsUnavailableError} When OpenCode's choice is credits.
 */
export async function planTurnWithoutCloud(
  runsOnCredits: () => boolean = openCodeRunsOnCredits
): Promise<OpenCodeSidecarPlan> {
  if (runsOnCredits()) throw new CreditsUnavailableError('not-supported', OPENCODE_LABEL);
  return OPENCODE_OWN_PLAN;
}

/** How each side is said in a sentence. */
const SIDE_NAME: Record<OpenCodeSidecarMode, string> = {
  own: 'your own sign-in',
  credits: 'DorkOS credits',
};

/**
 * A turn asked for the other side of OpenCode's Runs on choice while another
 * OpenCode turn is still running on the side it is leaving. Switching restarts
 * OpenCode, which would end that turn, so the switch waits and this turn is
 * refused with nothing sent. The message is the sentence a person reads.
 */
export class OpenCodeSwitchPendingError extends Error {
  /** Stable code the chat can key on. */
  readonly code = 'runtime_switch_pending';

  /**
   * Build the refusal for one turn.
   *
   * @param from - The side OpenCode is running on now.
   * @param to - The side the person switched to.
   */
  constructor(
    readonly from: OpenCodeSidecarMode,
    readonly to: OpenCodeSidecarMode
  ) {
    super(
      `OpenCode is still finishing a reply on ${SIDE_NAME[from]}, so it can't move to ${SIDE_NAME[to]} yet and nothing was sent. Send this again once that reply is done.`
    );
    this.name = 'OpenCodeSwitchPendingError';
  }
}
