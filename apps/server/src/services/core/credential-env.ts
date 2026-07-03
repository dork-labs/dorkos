/**
 * Credential env-injection helpers — the seam where a stored credential
 * REFERENCE becomes a real secret in a runtime's subprocess env at spawn time
 * (ADR-0315, effortless-runtime-switching T1, task 2.2).
 *
 * Each runtime resolves its reference here, per-spawn, and spreads the returned
 * fragment into its child env. Resolution is never cached as plaintext and the
 * secret is never logged (only the target env-var name and a failure reason are
 * ever logged). A missing or dangling reference yields `{}` — the runtime falls
 * back to host/delegated-login auth rather than an empty-string secret.
 *
 * Codex is deliberately absent: it never sets `CodexOptions.env` (setting env
 * would drop PATH/HOME/CODEX_HOME — codex/NOTES.md), so Codex auth routes
 * through the delegated `codex login` (task 2.3), not an env var.
 *
 * @module services/core/credential-env
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../lib/logger.js';
import { credentialProvider, type CredentialProvider } from './credential-provider.js';
import { configManager } from './config-manager.js';

/**
 * Provider id in the top-level `providers` registry whose reference feeds
 * Claude's `ANTHROPIC_API_KEY`. Claude has no per-runtime credential field; its
 * key (when the operator supplies one) lives in the shared registry.
 */
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/**
 * Env var each OpenCode provider id injects into the sidecar spawn env. A small
 * explicit map (not a guess): an unrecognized provider id injects nothing.
 * Extended by later T1 tasks (OpenRouter 2.6, provider picker 2.8).
 */
const OPENCODE_PROVIDER_ENV_VARS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/**
 * Resolve a single reference into a one-key env fragment, or `{}` when the
 * reference is absent or dangling. Logs only the (public) env-var name and the
 * failure reason — never the secret, never the reference value.
 */
async function resolveRefToEnvVar(
  provider: CredentialProvider,
  ref: string | null | undefined,
  envVar: string
): Promise<Record<string, string>> {
  if (!ref) return {};
  const result = await provider.resolve(ref);
  if (result.ok) return { [envVar]: result.secret };
  logger.warn(`[credentials] ${envVar} reference did not resolve`, { reason: result.reason });
  return {};
}

/**
 * Resolve the Claude credential reference (from the top-level `providers`
 * registry) into an `ANTHROPIC_API_KEY` env fragment for the Claude SDK
 * subprocess. Returns `{}` when no Claude reference is configured — leaving
 * host/delegated-login auth untouched — or when it is dangling. Never throws.
 *
 * @param provider - Credential read port (defaults to the module singleton).
 * @param config - Config reader (defaults to the module singleton).
 */
export async function resolveClaudeCredentialEnv(
  provider: CredentialProvider = credentialProvider,
  config: ConfigReader = configManager
): Promise<Record<string, string>> {
  try {
    const ref = config.get('providers')[ANTHROPIC_PROVIDER_ID];
    return await resolveRefToEnvVar(provider, ref, 'ANTHROPIC_API_KEY');
  } catch (err) {
    logger.debug('[credentials] Claude credential resolution skipped', { err: String(err) });
    return {};
  }
}

/**
 * Resolve OpenCode's selected-provider credential (and optional base URL) into
 * a spawn-env fragment for the `opencode serve` sidecar. Injects the provider's
 * API key (mapped from the selected provider id) and `OPENAI_BASE_URL` when a
 * custom base URL is configured. Returns `{}` when no provider is selected or
 * its reference is dangling. Never throws.
 *
 * @param provider - Credential read port (defaults to the module singleton).
 * @param config - Config reader (defaults to the module singleton).
 */
export async function resolveOpenCodeProviderEnv(
  provider: CredentialProvider = credentialProvider,
  config: ConfigReader = configManager
): Promise<Record<string, string>> {
  try {
    const opencode = config.get('runtimes').opencode;
    const env: Record<string, string> = {};

    const providerId = opencode.provider;
    if (providerId) {
      const envVar = OPENCODE_PROVIDER_ENV_VARS[providerId];
      const ref = config.get('providers')[providerId];
      if (envVar) {
        Object.assign(env, await resolveRefToEnvVar(provider, ref, envVar));
      } else if (ref) {
        logger.warn('[credentials] OpenCode provider has no known env-var mapping', {
          provider: providerId,
        });
      }
    }

    if (opencode.baseURL) {
      env.OPENAI_BASE_URL = opencode.baseURL;
    }

    return env;
  } catch (err) {
    logger.debug('[credentials] OpenCode provider env resolution skipped', { err: String(err) });
    return {};
  }
}
