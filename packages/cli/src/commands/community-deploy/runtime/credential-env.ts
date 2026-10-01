/**
 * Credential variables a person can export to choose which Fly or Neon account setup acts as.
 *
 * `fly` reads `FLY_ACCESS_TOKEN`, then `FLY_API_TOKEN`, ahead of its saved `fly auth login`
 * session (flyctl `internal/config/config.go`, `applyEnv`). It takes the first one that is
 * *set*, even when it is empty, and an empty one then leaves the saved session in charge. So
 * setup only ever hands these tools a non-empty variable: what the notice names is what `fly`
 * uses. `neonctl` 5 reads `NEON_API_KEY` ahead of its saved `neonctl auth` profile (neon
 * `dist/utils/middlewares.js`, `resolveApiKeyFromEnv`), where empty means unset.
 *
 * Only `fly` and `neonctl` receive these. `gh`, the clipboard tools and the browser opener get
 * the environment without them. No value is ever copied anywhere else: not into the journal, a
 * receipt, a message, or an argument.
 *
 * @module commands/community-deploy/runtime/credential-env
 */

/** Credential variables passed through, unchanged, to `fly` and `neonctl` when non-empty. */
export const COMMUNITY_CREDENTIAL_ENV_NAMES = [
  'FLY_ACCESS_TOKEN',
  'FLY_API_TOKEN',
  'NEON_API_KEY',
] as const;

/** One credential variable name the launcher passes through. */
export type CommunityCredentialEnvName = (typeof COMMUNITY_CREDENTIAL_ENV_NAMES)[number];

type Env = Readonly<Record<string, string | undefined>>;

const CREDENTIAL_NAMES: ReadonlySet<string> = new Set(COMMUNITY_CREDENTIAL_ENV_NAMES);

/**
 * Pick the credential variables to hand to `fly` and `neonctl`, dropping empty ones.
 *
 * @param source - The launching shell's environment.
 * @returns Only the credential variables that hold a value.
 */
export function pickCommunityCredentialEnv(source: Env): Record<string, string> {
  return Object.fromEntries(
    COMMUNITY_CREDENTIAL_ENV_NAMES.flatMap((name) => {
      const value = source[name];
      return typeof value === 'string' && value !== '' ? [[name, value]] : [];
    })
  );
}

/**
 * Remove every credential variable, for the tools that are not `fly` or `neonctl`.
 *
 * @param env - The environment setup hands to `fly` and `neonctl`.
 * @returns The same environment without any Fly or Neon credential.
 */
export function withoutCommunityCredentialEnv(
  env: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAMES.has(name)));
}

/**
 * Name the Fly variable `fly` will sign in with, the way flyctl decides it.
 *
 * flyctl takes the first of the two that is set, even when empty; an empty token then means
 * the saved session is used, so this returns null for it.
 *
 * @param env - The environment setup passes to `fly`.
 * @returns The variable `fly` signs in with, or null when it uses the saved session.
 */
export function flyCredentialEnvInUse(env: Env): 'FLY_ACCESS_TOKEN' | 'FLY_API_TOKEN' | null {
  for (const name of ['FLY_ACCESS_TOKEN', 'FLY_API_TOKEN'] as const) {
    const value = env[name];
    if (typeof value === 'string') return value === '' ? null : name;
  }
  return null;
}

/**
 * Say, in one line, which credentials from the environment setup will use.
 *
 * The line names variables only. It never contains a value, so it is safe to print and log.
 *
 * @param env - The environment setup passes to `fly` and `neonctl`.
 * @returns One line ending in a newline, or an empty string when no credential variable is used.
 */
export function formatCommunityCredentialNotice(env: Env): string {
  const fly = flyCredentialEnvInUse(env);
  const neon = typeof env.NEON_API_KEY === 'string' && env.NEON_API_KEY !== '';
  const parts = [
    ...(fly ? [`the Fly token in ${fly}`] : []),
    ...(neon ? ['the Neon key in NEON_API_KEY'] : []),
  ];
  if (parts.length === 0) return '';
  const shadowed =
    fly === 'FLY_ACCESS_TOKEN' && typeof env.FLY_API_TOKEN === 'string' && env.FLY_API_TOKEN !== ''
      ? ' FLY_API_TOKEN is set too, but Fly reads FLY_ACCESS_TOKEN first.'
      : '';
  const signIns = parts.length > 1 ? 'your saved sign-ins' : 'your saved sign-in';
  return `Using ${parts.join(' and ')} from your environment, not ${signIns}.${shadowed}\n`;
}

/**
 * Name, for a sentence, the credential `fly` or `neonctl` acts with: an exported variable, or
 * the saved sign-in. It names variables only, never a value.
 *
 * @param service - Which tool's credential to describe.
 * @param env - The environment setup passes to `fly` and `neonctl`.
 * @returns A sentence subject such as "The Neon key in NEON_API_KEY" or "Your Fly sign-in".
 */
export function describeCommunityCredential(service: 'fly' | 'neon', env: Env): string {
  if (service === 'neon') {
    return typeof env.NEON_API_KEY === 'string' && env.NEON_API_KEY !== ''
      ? 'The Neon key in NEON_API_KEY'
      : 'Your Neon sign-in';
  }
  const fly = flyCredentialEnvInUse(env);
  return fly ? `The Fly token in ${fly}` : 'Your Fly sign-in';
}
