/**
 * Whether a Claude Code session bills per token rather than against its
 * account's subscription (spec `claude-account-fleet` §6 U). A per-token
 * session's `usage` is its own pay-as-you-go cost, never its folder's
 * subscription windows.
 *
 * Decided from what the official binary is actually handed, never from a
 * credential's value: the NAMES of the variables in the child's final
 * environment, whatever put them there (a stored key, DorkOS credits, or the
 * server's own environment), and the `apiKeySource` the binary reports on its
 * session-init message. Nothing here reads a key.
 *
 * @module services/runtimes/claude-code/messaging/per-token-billing
 */
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { resolveClaudeCredentialEnv } from '../../../core/credential-env.js';
import { creditsTurnEnv } from '../../../core/cloud/credits-inference.js';

/** Variables whose presence makes the binary bill a key or a gateway token, not a sign-in. */
const PER_TOKEN_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** `apiKeySource` values that mean the subscription sign-in pays. */
const SUBSCRIPTION_KEY_SOURCES: ReadonlySet<string> = new Set(['none', 'oauth']);

/**
 * Whether a launch environment bills per token.
 *
 * @param env - The environment the child process receives.
 */
export function envBillsPerToken(env: Readonly<Record<string, string | undefined>>): boolean {
  return PER_TOKEN_ENV_VARS.some((name) => (env[name] ?? '') !== '');
}

/**
 * Whether the binary's reported key source bills per token: anything but
 * `none` or `oauth` (an environment key, a helper, a managed or org key).
 *
 * @param apiKeySource - The `apiKeySource` from the session-init message.
 */
export function keySourceBillsPerToken(apiKeySource: string): boolean {
  return !SUBSCRIPTION_KEY_SOURCES.has(apiKeySource);
}

/**
 * What a launch made now would bill: the environment it would receive, built
 * the way a turn builds it. When that cannot be worked out, the answer is per
 * token, so a session is never shown a subscription bar it may not have.
 */
export async function predictLaunchBillsPerToken(): Promise<boolean> {
  try {
    const env = runtimeEnvironment('claude-code', 'turn', {
      ...(await resolveClaudeCredentialEnv()),
      ...creditsTurnEnv('claude-code'),
    });
    return envBillsPerToken(env);
  } catch {
    return true;
  }
}
