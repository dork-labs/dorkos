/** Legacy SDK-shaped credits values for scripted test fixtures only. */
import type { CodexOptions } from '@openai/codex-sdk';
import { CODEX_CREDITS_PROVIDER_ID, codexRoutesOrPays } from '../../credits-launch.js';
import { creditsCodexHome } from '../../codex-home.js';
import {
  type CreditsLaunch,
  creditsTokenEnv,
  isCreditsTokenVar,
  mintCreditsTokenVar,
} from '../../../../core/cloud/credits-protocols.js';
/**
 * The process environment of a credits turn: the projected environment minus
 * every name that routes or pays (and any older credits token), the credits
 * home, and the token under this turn's own variable.
 *
 * @param projected - The environment `buildCodexOptions` built for the turn.
 * @param launch - The resolved credits launch.
 * @param tokenVar - This turn's token variable.
 */
export function codexCreditsProcessEnv(
  projected: Readonly<Record<string, string>>,
  launch: CreditsLaunch,
  tokenVar: string
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (!codexRoutesOrPays(name) && !isCreditsTokenVar(name)) kept[name] = value;
  }
  return { ...kept, CODEX_HOME: creditsCodexHome(), ...creditsTokenEnv(launch, tokenVar) };
}

/**
 * What a credits turn's config overrides carry: the provider entry that points
 * the turn at the credits endpoint (the base URL, not a secret; the responses
 * wire format; the NAME of the variable the token is in;
 * `requires_openai_auth = false`, so the CLI never looks for a ChatGPT
 * sign-in), and web search switched off.
 *
 * Web search is a tool Codex's own vendor runs and bills per search, so the
 * credits endpoint cannot carry it and refuses any request that offers it:
 * left on, every credits turn would be refused. `web_search = "disabled"`
 * takes it out of the tool list (checked against Codex 0.154). It rides the
 * command line for this turn only; the person's own `config.toml` and their
 * own-sign-in turns are untouched.
 *
 * @param launch - The resolved credits launch.
 * @param tokenVar - This turn's token variable.
 */
export function codexCreditsConfig(
  launch: CreditsLaunch,
  tokenVar: string
): Record<string, unknown> {
  return {
    model_provider: CODEX_CREDITS_PROVIDER_ID,
    model_providers: {
      [CODEX_CREDITS_PROVIDER_ID]: {
        name: 'DorkOS credits',
        base_url: launch.baseUrl,
        env_key: tokenVar,
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
    web_search: 'disabled',
  };
}

/**
 * Turn a client's options into a credits turn's: the credits config merged
 * into its config (after everything else, so nothing it carried can override
 * it) and the credits environment in place of its own.
 *
 * @param options - The options `buildCodexOptions` built for the turn.
 * @param launch - The resolved credits launch.
 * @param tokenVar - The token's variable; a fresh one per turn unless a test names it.
 */
export function withCodexCredits(
  options: CodexOptions,
  launch: CreditsLaunch,
  tokenVar: string = mintCreditsTokenVar()
): CodexOptions {
  return {
    ...options,
    config: { ...(options.config ?? {}), ...codexCreditsConfig(launch, tokenVar) },
    env: codexCreditsProcessEnv(options.env ?? {}, launch, tokenVar),
  } as CodexOptions;
}
