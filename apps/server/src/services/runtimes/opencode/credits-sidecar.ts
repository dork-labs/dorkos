/**
 * OpenCode on DorkOS credits (ADR 261001-000811): what the sidecar runs on, and
 * the config and environment that make the credits endpoint the only place a
 * turn can go.
 *
 * ## One choice for the whole runtime
 *
 * OpenCode runs every session through ONE managed `opencode serve` sidecar
 * (ADR-0308), and anything in that process (a project's plugin, say) can read
 * its environment. A credits token in the sidecar that also serves the
 * person's own providers would be readable by every project opened there,
 * including ones never set to credits. So credits are a MODE of the sidecar,
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
 * - The token is never in the config, only referenced (`{env:…}`) under a
 *   variable name drawn fresh for every boot, and rides the sidecar's
 *   environment, where the person's own provider keys are not. OpenCode
 *   substitutes `{env:NAME}` and `{file:PATH}` in a project's config too, so
 *   a fixed name would let a project's remote MCP header carry the token
 *   away; a project cannot name a variable it never sees. (Reading the boot's
 *   config with `{env:OPENCODE_CONFIG_CONTENT}` yields the name, not the
 *   token: substitution is one pass.)
 *
 * What it does not protect against: code the sidecar runs for a project on
 * credits (its plugins, its tools) can read the token, as it could the person's
 * own key on their own sign-in.
 *
 * Models are not known to OpenCode for a custom provider, so the credits
 * provider is given the list the service publishes for this link
 * (`GET /v1/inference/models`). A turn picks the session's model when it is
 * one of those, else the first one that can call tools, else the first.
 *
 * This module is the pure half (the plan, the config, the environment), so the
 * sidecar manager can build a boot from it without loading the cloud client;
 * `credits-mode.ts` is the half that asks for the token and the models.
 *
 * @module services/runtimes/opencode/credits-sidecar
 */
import type { InferenceModel } from '@dork-labs/cloud-api';
import {
  CreditsUnavailableError,
  creditsTokenEnv,
  isCreditsTokenVar,
  type CreditsLaunch,
} from '../../core/cloud/credits-protocols.js';
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
 * person's provider keys and endpoint, plus the credits token when there is
 * one. A credits sidecar with no token runs, so sessions can still be listed
 * and read, but has nothing it can pay with: every turn on it is refused
 * before it is sent.
 *
 * @param projected - The environment `runtimeEnvironment` built for the sidecar.
 * @param launch - The credits launch, or `null` when no token is held.
 * @param tokenVar - This boot's token variable, drawn fresh per boot so a
 *   project's `opencode.json` cannot name it in an `{env:…}`.
 */
export function openCodeCreditsEnv(
  projected: Readonly<Record<string, string>>,
  launch: CreditsLaunch | null,
  tokenVar: string
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (!PERSON_PROVIDER_NAMES.has(name) && !isCreditsTokenVar(name)) kept[name] = value;
  }
  return launch ? { ...kept, ...creditsTokenEnv(launch, tokenVar) } : kept;
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
 * one enabled, its endpoint, the token's variable by name, its models and the
 * default ones. With no launch, the allow list alone, so nothing can run.
 *
 * @param launch - The credits launch, or `null` when no token is held.
 * @param available - The credits models.
 * @param tokenVar - This boot's token variable, named here and set only in the env.
 */
export function openCodeCreditsConfig(
  launch: CreditsLaunch | null,
  available: readonly InferenceModel[],
  tokenVar: string
): Record<string, unknown> {
  const pinned = { enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID] };
  const fallback = creditsModelFor(undefined, available);
  if (launch === null || fallback === null) return pinned;
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
          baseURL: launch.baseUrl,
          apiKey: `{env:${tokenVar}}`,
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

/** What one sidecar boot runs on. Carries the token in `env` only. */
export interface OpenCodeSidecarPlan {
  /** Which side. */
  mode: OpenCodeSidecarMode;
  /**
   * What identifies this plan without the token: two plans with the same
   * fingerprint boot the same sidecar. Never contains a credential.
   */
  fingerprint: string;
  /** The credits launch, on credits with a token; else `null`. */
  launch: CreditsLaunch | null;
  /** The credits models, on credits; else empty. */
  models: InferenceModel[];
}

/**
 * The fingerprint of a credits plan: its token id, endpoint and model list.
 * Never the token.
 *
 * @param launch - The credits launch, or `null`.
 * @param available - The credits models.
 */
export function openCodeCreditsFingerprint(
  launch: CreditsLaunch | null,
  available: readonly InferenceModel[]
): string {
  if (launch === null) return 'credits:none';
  return `credits:${launch.tokenId}:${launch.baseUrl}:${available.map((model) => model.id).join(',')}`;
}

/** The plan for the person's own sign-in: no credits variable, no credits provider. */
export const OPENCODE_OWN_PLAN: OpenCodeSidecarPlan = {
  mode: 'own',
  fingerprint: 'own',
  launch: null,
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
    ? {
        mode: 'credits',
        fingerprint: openCodeCreditsFingerprint(null, []),
        launch: null,
        models: [],
      }
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
 * A turn needs OpenCode restarted while another OpenCode turn is still
 * running: either it asked for the other side of OpenCode's Runs on choice, or
 * the running sidecar's credits token is too close to expiry to start another
 * turn on. Restarting would end the running turn, so it waits, and this turn is
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
      from === to
        ? 'OpenCode is still finishing a reply, and its DorkOS credits key has to be renewed before it can start another, so nothing was sent. Send this again once that reply is done.'
        : `OpenCode is still finishing a reply on ${SIDE_NAME[from]}, so it can't move to ${SIDE_NAME[to]} yet and nothing was sent. Send this again once that reply is done.`
    );
    this.name = 'OpenCodeSwitchPendingError';
  }
}
