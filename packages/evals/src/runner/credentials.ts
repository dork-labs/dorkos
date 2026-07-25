/**
 * How a credentialed eval reaches a model.
 *
 * The question this module answers is **"can the runtime actually reach a
 * model?"**, not "is one particular environment variable set?". Those are not the
 * same question, and treating them as the same is what kept the credentialed
 * tiers from running on a developer's own machine: `claude` is on `PATH` and
 * signed in there, which is exactly how every DorkOS agent reaches a model every
 * day, and no API key is involved.
 *
 * Three sources, in this order:
 *
 * 1. `ANTHROPIC_API_KEY` — what CI dispatches with. Billed to the Anthropic API
 *    account that owns the key.
 * 2. `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived token from `claude setup-token`.
 *    Billed to the Claude subscription that made it. **The name is pinned here on
 *    purpose.** An earlier version of the eval workflow let the caller name which
 *    secret to read, which meant a dispatcher could point the run at any secret in
 *    the repo and have it shipped to a third party as an auth header. Never
 *    reintroduce a "which secret?" input; add a new pinned name instead.
 * 3. The `claude` CLI signed in on this machine — the default for local runs, and
 *    the reason a developer needs no setup beyond being signed in. Billed to that
 *    developer's own Claude subscription.
 *
 * ## Portable vs inherited, which is what the docker tier turns on
 *
 * Sources 1 and 2 are values, so they can be handed to anything, including a
 * container. Source 3 is not a value at all: it is a sign-in stored in the host
 * keychain (or `~/.claude`), and the only reason it works for an eval is that the
 * child-process launcher inherits `PATH` and `HOME` from the runner.
 *
 * The docker launcher deliberately does NOT inherit the host environment. Its
 * curated env is the containment property (ADR 260725-133222): no host
 * credentials, no host home, one bind mount. So the docker tier can use a
 * portable credential and cannot use the local sign-in, and the fix is never to
 * mount host credentials into a container that runs model-driven code.
 *
 * ## Fail-closed
 *
 * When no source resolves, the caller must report a runner **error**. A missing
 * credential is never a pass. This module reports "nothing resolved" and supplies
 * the message; {@link runEval} is what refuses to run.
 *
 * @module evals/runner/credentials
 */
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import { CredentialSourceSchema, type CredentialSource } from '../types.js';

/** The environment variable CI dispatches a credentialed run with. */
export const API_KEY_VAR = 'ANTHROPIC_API_KEY';

/**
 * The subscription token variable, PINNED to this exact name. See the module
 * docstring: letting a caller choose the variable is a credential-disclosure
 * lever, not a convenience.
 */
export const OAUTH_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/** A resolved way for a credentialed eval to reach a model. */
export interface ModelCredential {
  /** Which of the three sources answered. */
  source: CredentialSource;
  /**
   * Environment the launched server needs in order to use this credential.
   * Empty for the local sign-in, which travels as inherited `PATH` + `HOME`
   * rather than as a value.
   */
  env: Record<string, string>;
  /**
   * True when the credential is a value that can be handed to an isolated
   * environment (a container). False for the local sign-in, which only the
   * env-inheriting child-process tier can use.
   */
  portable: boolean;
}

/** Injectable seams so the resolver can be tested without a real CLI or a real key. */
export interface ResolveCredentialDeps {
  /** Environment to read the two pinned variables from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Probe for the machine's `claude` sign-in. Defaults to the shared runtime probe. */
  probeLocalLogin?: () => Promise<boolean>;
}

/** Read a pinned variable, treating an empty or whitespace-only value as unset. */
function readVar(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw && raw.trim() !== '' ? raw : undefined;
}

/**
 * Resolve how this run will reach a model, in the documented precedence.
 *
 * The local-sign-in probe runs LAST and only when neither pinned variable is set,
 * so a run that already has a key never pays for a subprocess.
 *
 * @param deps - Injectable env + probe seams; both default to the real ones.
 * @returns The resolved credential, or `undefined` when no source answered.
 */
export async function resolveModelCredential(
  deps: ResolveCredentialDeps = {}
): Promise<ModelCredential | undefined> {
  const env =
    deps.env ??
    // eslint-disable-next-line no-restricted-syntax -- the credentialed tier's model credential is a CI/runner secret read once here (the harness env carve-out pattern), not an app config value.
    process.env;

  const apiKey = readVar(env, API_KEY_VAR);
  if (apiKey) {
    return { source: 'anthropic-api-key', env: { [API_KEY_VAR]: apiKey }, portable: true };
  }

  const oauthToken = readVar(env, OAUTH_TOKEN_VAR);
  if (oauthToken) {
    return {
      source: 'claude-oauth-token',
      env: { [OAUTH_TOKEN_VAR]: oauthToken },
      portable: true,
    };
  }

  const probe = deps.probeLocalLogin ?? hasLocalClaudeLogin;
  if (await probe()) {
    return { source: 'local-claude-login', env: {}, portable: false };
  }

  return undefined;
}

/**
 * Whether a credential source bills a Claude subscription rather than the
 * Anthropic API. Subscription turns report no per-turn cost, so `$0.0000` on such
 * a run is expected rather than a missing-signal symptom.
 *
 * @param source - The resolved credential source.
 * @returns True for the two subscription-backed sources.
 */
export function isSubscriptionBilled(source: CredentialSource): boolean {
  return source === 'claude-oauth-token' || source === 'local-claude-login';
}

/** One human-readable line per source, for run output. */
const SOURCE_LABELS: Record<CredentialSource, string> = {
  'anthropic-api-key': `the ${API_KEY_VAR} environment variable (billed to that API account)`,
  'claude-oauth-token': `the ${OAUTH_TOKEN_VAR} environment variable (billed to that Claude subscription)`,
  'local-claude-login':
    'the Claude sign-in on this machine (billed to your own Claude subscription)',
};

/**
 * Describe a resolved source in one line, so a run's output says which credential
 * it used instead of leaving the reader to guess.
 *
 * @param source - The resolved credential source.
 * @returns The human-readable description.
 */
export function describeCredentialSource(source: CredentialSource): string {
  return SOURCE_LABELS[CredentialSourceSchema.parse(source)];
}

/**
 * The message a run gets when nothing resolved. Names every way to fix it, in
 * the order the resolver tries them, because "set ANTHROPIC_API_KEY" alone sent
 * developers looking for a key they did not need.
 *
 * @param tier - The tier that was requested.
 * @returns The runner-error message.
 */
export function noCredentialMessage(tier: string): string {
  return (
    `Tier '${tier}' needs a way to reach a model, and none was found. Any one of these fixes it:\n` +
    `  1. sign in on this machine: run \`claude auth login\` (the local default, and it spends against your own Claude subscription)\n` +
    `  2. set ${OAUTH_TOKEN_VAR} to a token from \`claude setup-token\`\n` +
    `  3. set ${API_KEY_VAR} to an Anthropic API key`
  );
}

/**
 * The message a docker-tier run gets when the only credential available is the
 * local sign-in. The container is sealed off from the host home on purpose, so
 * the fix is a portable credential or a different isolation tier, never mounting
 * host credentials into a container that runs model-driven code.
 *
 * @returns The runner-error message.
 */
export function dockerNeedsPortableCredentialMessage(): string {
  return (
    'The docker isolation tier needs a credential it can pass into the container, and the only ' +
    `one available is the Claude sign-in on this machine. Set ${API_KEY_VAR} or ` +
    `${OAUTH_TOKEN_VAR}, or run with \`--isolation child-process\` to use your local sign-in. ` +
    'The container is cut off from your home folder and your host credentials on purpose, so ' +
    'handing them to it would undo the containment the docker tier exists to provide.'
  );
}
