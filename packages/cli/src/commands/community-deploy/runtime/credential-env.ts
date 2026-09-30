/**
 * Credential variables a person can export to choose which Fly or Neon account setup acts as.
 *
 * `fly` reads `FLY_ACCESS_TOKEN`, then `FLY_API_TOKEN`, ahead of its saved `fly auth login`
 * session (flyctl `internal/config/config.go`, `applyEnv`). `neonctl` 5 reads `NEON_API_KEY`
 * ahead of its saved `neonctl auth` profile (neon `dist/utils/middlewares.js`,
 * `resolveApiKeyFromEnv`). The launcher passes these through to both tools unchanged and never
 * copies a value anywhere else: not into the journal, a receipt, a message, or an argument.
 *
 * @module commands/community-deploy/runtime/credential-env
 */

/** Credential variables passed through, unchanged, to `fly` and `neonctl` when set. */
export const COMMUNITY_CREDENTIAL_ENV_NAMES = [
  'FLY_ACCESS_TOKEN',
  'FLY_API_TOKEN',
  'NEON_API_KEY',
] as const;

/** One credential variable name the launcher passes through. */
export type CommunityCredentialEnvName = (typeof COMMUNITY_CREDENTIAL_ENV_NAMES)[number];

function isSet(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  // Both tools treat an empty value as unset, so an empty variable changes nothing.
  return typeof env[name] === 'string' && env[name] !== '';
}

/**
 * Name the Fly variable `fly` will sign in with, in flyctl's own order.
 *
 * @param env - The environment setup passes to `fly`.
 * @returns The variable `fly` reads first, or null when neither is set.
 */
export function flyCredentialEnvInUse(
  env: Readonly<Record<string, string | undefined>>
): 'FLY_ACCESS_TOKEN' | 'FLY_API_TOKEN' | null {
  if (isSet(env, 'FLY_ACCESS_TOKEN')) return 'FLY_ACCESS_TOKEN';
  if (isSet(env, 'FLY_API_TOKEN')) return 'FLY_API_TOKEN';
  return null;
}

/**
 * Say, in one line, which credentials from the environment setup will use.
 *
 * The line names variables only. It never contains a value, so it is safe to print and log.
 *
 * @param env - The environment setup passes to `fly` and `neonctl`.
 * @returns One line ending in a newline, or an empty string when no credential variable is set.
 */
export function formatCommunityCredentialNotice(
  env: Readonly<Record<string, string | undefined>>
): string {
  const fly = flyCredentialEnvInUse(env);
  const parts = [
    ...(fly ? [`the Fly token in ${fly}`] : []),
    ...(isSet(env, 'NEON_API_KEY') ? ['the Neon key in NEON_API_KEY'] : []),
  ];
  if (parts.length === 0) return '';
  const shadowed =
    fly === 'FLY_ACCESS_TOKEN' && isSet(env, 'FLY_API_TOKEN')
      ? ' FLY_API_TOKEN is set too, but Fly reads FLY_ACCESS_TOKEN first.'
      : '';
  const signIns = parts.length > 1 ? 'your saved sign-ins' : 'your saved sign-in';
  return `Using ${parts.join(' and ')} from your environment, not ${signIns}.${shadowed}\n`;
}
