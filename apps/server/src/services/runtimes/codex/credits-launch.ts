/**
 * A Codex turn on DorkOS credits (ADR 261001-000811): where it runs, which
 * conversations belong to credits, and the client options that make the
 * credits endpoint the only place its token can go.
 *
 * ## A home of its own
 *
 * Every credits conversation runs with `CODEX_HOME` set to a DorkOS-owned
 * folder, `<dorkHome>/runtimes/codex/credits`, never the person's `~/.codex`.
 * The person's config and sign-in stay in their own home. Credits threads
 * select a DorkOS-owned provider over app-server JSON-RPC; it points only at
 * the loopback credits relay. The relay holds the credits token and adds it
 * upstream, so neither the token nor a person's model key enters Codex.
 * Threads never move between homes: an unknown or wrong-home binding refuses
 * rather than charging a different account. Managed tools still pass through
 * the same pin and protected-file checks as own-sign-in threads.
 *
 * @module services/runtimes/codex/credits-launch
 */
import fs from 'node:fs';
import { logger } from '../../../lib/logger.js';
import { creditsCodexHome } from './codex-home.js';
import { isCreditsTokenVar } from '../../core/cloud/credits-protocols.js';
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
 * The process environment of the credits-home app-server (ADR 261005-113107):
 * the projected environment minus every name that routes or pays, and the
 * credits home. No token at all — on app-server the token never enters
 * Codex's process; the thread's provider points at the credits relay, which
 * adds it on the way out.
 *
 * @param projected - `runtimeEnvironment('codex', 'turn')`.
 */
export function codexCreditsAppServerEnv(
  projected: Readonly<Record<string, string>>
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (!codexRoutesOrPays(name) && !isCreditsTokenVar(name)) kept[name] = value;
  }
  return { ...kept, CODEX_HOME: creditsCodexHome() };
}

/**
 * The thread config that points an app-server thread at the credits relay: the
 * `dorkos-credits` provider with the relay's loopback URL and the relay key
 * this credits process was issued, and web search off (the credits endpoint
 * cannot carry the vendor's billed search). Sent over stdin inside
 * `thread/start`/`thread/resume`, never argv or environment.
 *
 * @param relay - The relay's base URL and this process's key.
 */
export function codexCreditsThreadConfig(relay: {
  baseUrl: string;
  key: string;
}): Record<string, unknown> {
  return {
    model_provider: CODEX_CREDITS_PROVIDER_ID,
    model_providers: {
      [CODEX_CREDITS_PROVIDER_ID]: {
        name: 'DorkOS credits',
        base_url: relay.baseUrl,
        wire_api: 'responses',
        requires_openai_auth: false,
        experimental_bearer_token: relay.key,
      },
    },
    web_search: 'disabled',
  };
}
