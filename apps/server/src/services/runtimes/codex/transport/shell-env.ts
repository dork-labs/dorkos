/**
 * What every shell a Codex thread runs is handed (`shell_environment_policy.set`).
 *
 * @module services/runtimes/codex/transport/shell-env
 */
import type { CodexTurnTools } from './codex-transport.js';

/**
 * npm and pnpm read `~/.npmrc` on every run, and the profile denies it (it can
 * hold a token), so they stopped with EPERM. Pointing their user config at an
 * empty file keeps it denied and lets them run (Security, DOR-4358).
 */
const NPM_USER_CONFIG = { NPM_CONFIG_USERCONFIG: '/dev/null' };

/**
 * The shell variables one thread loads with: an empty npm user config, the
 * agent identity token, the chat's agent and space references
 * (`turn-reference-env.ts`), and the server-owned DorkOS chat id. Vendor
 * thread ids differ, so the chat id is always DorkOS's own, and it is written
 * last so nothing above can replace it.
 *
 * @param tools - The turn's tools, which carry the token and the references.
 * @param sessionId - The DorkOS chat id.
 */
export function codexShellEnv(
  tools: Pick<CodexTurnTools, 'agentTokenEnv' | 'referenceEnv'>,
  sessionId: string
): Record<string, string> {
  return {
    ...NPM_USER_CONFIG,
    ...tools.agentTokenEnv,
    ...tools.referenceEnv,
    DORKOS_SESSION_ID: sessionId,
  };
}
