/**
 * A Codex turn on DorkOS credits (ADR 261001-000811): where it runs, which
 * conversations belong to credits, and the client options that make the
 * credits endpoint the only place its token can go.
 *
 * ## A home of its own
 *
 * Every credits conversation runs with `CODEX_HOME` set to a DorkOS-owned
 * folder, `<dorkHome>/runtimes/codex/credits`, never the person's `~/.codex`.
 * Three things follow, and each is the point:
 *
 * - **The person's own setup is never touched.** Their `config.toml`, their
 *   sign-in (`auth.json`) and their `OPENAI_BASE_URL` are neither read nor
 *   written by a credits turn. Credits are a model provider entry DorkOS hands
 *   the CLI per turn on its command line, not an edit to anything they wrote.
 *   The flip side, said plainly: a credits conversation does not get their own
 *   MCP servers, global `AGENTS.md` or profiles from `~/.codex` either; the
 *   servers DorkOS injects per turn still ride `--config` as on any turn.
 * - **Nothing else can pay.** The folder holds no sign-in, and a credits turn's
 *   environment carries no `OPENAI_*` or `CODEX_*` name of the person's, so
 *   the only credential the CLI can find is the credits token. A turn that lost
 *   the token fails with no request at all (proved against the bundled binary).
 * - **A conversation stays on whatever paid for it.** A Codex thread lives in
 *   the home it started in, the same rule as a Claude Code session's folder
 *   (ADR 260801-204127), so which side a thread is on is read off the disk
 *   ({@link threadRunsOnCredits}) rather than stored. A thread that is in
 *   neither home cannot be resumed anywhere, so a wrong answer fails the turn;
 *   it can never bill the other side.
 *
 * ## The provider entry, and why a folder cannot redirect it
 *
 * The CLI is told `model_provider = "dorkos-credits"` and given that provider
 * (endpoint, `wire_api = "responses"`, `env_key` naming the token's variable)
 * as `--config` overrides, which outrank every config file. Codex also ignores
 * provider and endpoint keys in a project's own `.codex/config.toml`, and loads
 * none of it for a folder the home has not trusted, which the credits home
 * never does. The endpoint is not a secret and rides the command line; the
 * token is, and rides only the environment, named in config by
 * a variable whose name is drawn fresh for every turn
 * (`mintCreditsTokenVar`), so nothing outside DorkOS can ask for it by name.
 *
 * What this does not protect against is the same as for Claude Code: code the
 * turn runs (an MCP server, a command) can read the token from its own
 * environment, exactly as it could read a person's own key.
 *
 * @module services/runtimes/codex/credits-launch
 */
import fs from 'node:fs';
import type { CodexOptions } from '@openai/codex-sdk';
import { logger } from '../../../lib/logger.js';
import { creditsCodexHome } from './codex-home.js';
import {
  type CreditsLaunch,
  creditsTokenEnv,
  isCreditsTokenVar,
  mintCreditsTokenVar,
} from '../../core/cloud/credits-protocols.js';
import { locateCodexRollout } from './turn-context-usage.js';

/** The model provider id a credits turn selects. Never one a person's config can define for us. */
export const CODEX_CREDITS_PROVIDER_ID = 'dorkos-credits';

/** Make sure the credits home exists, so the CLI can write a thread's rollout there. */
export function ensureCreditsCodexHome(): void {
  try {
    fs.mkdirSync(creditsCodexHome(), { recursive: true });
  } catch (err) {
    logger.warn('[CodexRuntime] could not create the credits home', { err: String(err) });
  }
}

/**
 * Whether an existing Codex thread runs on credits: its rollout lives in the
 * credits home. `false` for anything not found there, which sends the turn to
 * the person's own home, where a credits thread does not exist and the resume
 * fails rather than running on their sign-in.
 *
 * @param threadId - The thread bound to the session.
 */
export async function threadRunsOnCredits(threadId: string): Promise<boolean> {
  return (await locateCodexRollout({ threadId, codexHome: creditsCodexHome() })) !== null;
}

/**
 * Names that route a Codex turn or pay for one. A credits turn takes none of
 * them from the person's environment, whichever list carried them:
 * `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, their `CODEX_HOME` and
 * every future name in those families. `CODEX_HOME` is then set to the credits
 * home.
 */
const CODEX_ROUTING_OR_PAYING_FAMILY = /^(OPENAI_|CODEX_|AZURE_OPENAI_)/i;

/**
 * Whether a variable routes a Codex turn or pays for one.
 *
 * @param name - The variable's name.
 */
export function codexRoutesOrPays(name: string): boolean {
  return CODEX_ROUTING_OR_PAYING_FAMILY.test(name);
}

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
 * The provider entry that points a turn at the credits endpoint: the base URL
 * (not a secret), the responses wire format, and the NAME of the variable the
 * token is in. `requires_openai_auth = false`, so the CLI never looks for a
 * ChatGPT sign-in.
 *
 * @param launch - The resolved credits launch.
 * @param tokenVar - This turn's token variable.
 */
export function codexCreditsProviderConfig(
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
  };
}

/**
 * Turn a client's options into a credits turn's: the provider entry merged
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
    config: { ...(options.config ?? {}), ...codexCreditsProviderConfig(launch, tokenVar) },
    env: codexCreditsProcessEnv(options.env ?? {}, launch, tokenVar),
  } as CodexOptions;
}
