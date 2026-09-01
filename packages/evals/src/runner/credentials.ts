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
 * ## A fourth source, for a different bill entirely
 *
 * {@link resolvePaidProviderCredential} answers a separate question for the
 * `real-provider` tier: **may this run spend on an external provider, and with
 * what?** It is kept apart from the three above rather than appended to them,
 * because the three are all ways of reaching Anthropic — and any of them can be
 * true on a developer machine by accident. This one bills an OpenRouter account
 * and therefore needs TWO deliberate acts: the flag AND the key. Never fold it
 * into the ladder above; a tier that can be armed by a stray environment
 * variable is not gated.
 *
 * ## Fail-closed
 *
 * When no source resolves, the caller must report a runner **error**. A missing
 * credential is never a pass. This module reports "nothing resolved" and supplies
 * the message; {@link runEval} is what refuses to run.
 *
 * ## What is deliberately NOT here
 *
 * The pinned variable NAMES and the two label/billing helpers live in `types.ts`.
 * Resolving a credential means shelling out to the `claude` binary, and
 * `report/summary.ts` needs those helpers to print two lines. Keeping them here
 * would drag the auth probe into the reporting path for nothing.
 *
 * @module evals/runner/credentials
 */
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import {
  API_KEY_VAR,
  OAUTH_TOKEN_VAR,
  OPENROUTER_API_KEY_VAR,
  PAID_PROVIDER_OPT_IN_VAR,
  type CredentialSource,
} from '../types.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// The paid external-provider tier (`real-provider`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether somebody DECIDED to spend on an external provider in this process.
 *
 * Read ONCE, at module scope, and that is the entire defense. A `vi.stubEnv` in
 * some other file cannot blank it afterwards, and a lazily-read flag would be
 * exactly the kind of thing a helper could flip on the way to a turn. It is the
 * same shape as `DORKOS_EVALS_CREDENTIALED` in
 * `runner/__tests__/harness-server.test.ts`, for the same reason.
 */
// eslint-disable-next-line no-restricted-syntax -- the opt-in flag IS the spend gate; reading it here (once, at module scope) is what makes it un-stubbable.
const PAID_PROVIDER_OPT_IN = process.env[PAID_PROVIDER_OPT_IN_VAR] === '1';

/**
 * Whether this run will hand a PAID EXTERNAL PROVIDER credential to a runtime —
 * the one question the spend gate may key on.
 *
 * **It deliberately does not ask about the tier.** Keying the gate on
 * `tier === 'real-provider'` was a hole, and the exact command that walked
 * through it is worth keeping written down:
 *
 * ```
 * pnpm evals -- --suite chat --tier claude-code-cheap \
 *   --runtime opencode --model openrouter/qwen/qwen3.7-flash
 * ```
 *
 * That reached OpenRouter and spent real money with `DORKOS_EVALS_PAID_PROVIDER`
 * never set, because `--runtime` carried no tier restriction: `run-suite` left
 * `provider` undefined on a cheap tier, `harness-server` defaulted it back to
 * `openrouter`, the sandbox config got a `providers.openrouter` reference, and
 * the launcher's `...process.env` carried an exported key into the sidecar. The
 * run then recorded `credentialSource: 'anthropic-…'`, so it named the wrong
 * bill on the way out.
 *
 * So the rule is the money, not the label: an OpenCode boot always names an
 * external provider (it is the only runtime that fronts one — ADR-0308 +
 * ADR-0315), and any run that names a provider at all is asking to spend
 * somebody's provider account. Both arms gate. A future runtime that fronts
 * providers must be added here in the same breath as its adapter.
 *
 * @param tier - The tier the run booted.
 * @param runtime - The agent runtime the run resolved, if any.
 * @param provider - The provider the run resolved, if any.
 * @returns True when the paid gate must be satisfied before anything boots.
 */
export function spendsOnExternalProvider(
  tier: string,
  runtime: string | undefined,
  provider: string | undefined
): boolean {
  return tier === 'real-provider' || runtime === 'opencode' || provider !== undefined;
}

/** Injectable seams for {@link resolvePaidProviderCredential}. */
export interface ResolvePaidProviderDeps {
  /** Environment to read {@link OPENROUTER_API_KEY_VAR} from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Whether the deliberate-act flag is set. Defaults to the module-scope read,
   * which is the real gate — this seam exists so the unit tests can exercise all
   * four squares of the (flag × key) truth table without setting a real one.
   */
  optIn?: boolean;
}

/** Why a `real-provider` run may not spend, or the credential that lets it. */
export type PaidProviderGate =
  /** Both deliberate acts are present; here is the credential to boot with. */
  | { ok: true; credential: ModelCredential }
  /**
   * Nobody asked to spend. The run must STOP before it boots anything — this is
   * not a case-level failure, because no case was ever attempted.
   */
  | { ok: false; reason: 'no-opt-in'; message: string }
  /**
   * Somebody asked to spend and gave the runner nothing to spend with. This is a
   * runner ERROR per case, never a pass and never a quiet skip: a run that claims
   * to cover the paid tier and silently covered nothing is the worst outcome
   * available here.
   */
  | { ok: false; reason: 'no-key'; message: string };

/**
 * Decide whether this run may reach a PAID external provider, and with what.
 *
 * Two independent deliberate acts, BOTH required, and the order of the checks is
 * the policy: the flag is asked for first, so a machine that merely has a key
 * exported never even reaches the question of whether the key is good. A key
 * alone is not a person asking to spend money.
 *
 * @param deps - Injectable env + opt-in seams; both default to the real ones.
 * @returns The credential, or the refusal and why.
 */
export function resolvePaidProviderCredential(
  deps: ResolvePaidProviderDeps = {}
): PaidProviderGate {
  const optIn = deps.optIn ?? PAID_PROVIDER_OPT_IN;
  if (!optIn) {
    return { ok: false, reason: 'no-opt-in', message: paidProviderOptInMessage() };
  }

  const env =
    deps.env ??
    // eslint-disable-next-line no-restricted-syntax -- the paid tier's provider key is a runner secret read once here (the harness env carve-out pattern), not an app config value.
    process.env;
  const key = readVar(env, OPENROUTER_API_KEY_VAR);
  if (!key) {
    return { ok: false, reason: 'no-key', message: paidProviderNoKeyMessage() };
  }

  return {
    ok: true,
    credential: {
      source: 'openrouter-api-key',
      env: { [OPENROUTER_API_KEY_VAR]: key },
      portable: true,
    },
  };
}

/**
 * The message a paid-provider run gets when nobody set the opt-in flag. Says
 * plainly that the run spends real money outside any Claude subscription, so the
 * person reading it can decide rather than guess.
 *
 * Deliberately says nothing about the TIER: the gate keys on what the run
 * reaches ({@link spendsOnExternalProvider}), and a message naming
 * `real-provider` would read as a non-sequitur to somebody who typed
 * `--tier claude-code-cheap --runtime opencode` — the exact command this gate
 * exists to stop.
 *
 * @returns The refusal message.
 */
export function paidProviderOptInMessage(): string {
  return (
    `This run would spend real money on an external provider, so it needs you to say so: set ` +
    `${PAID_PROVIDER_OPT_IN_VAR}=1 alongside ${OPENROUTER_API_KEY_VAR}.\n` +
    `A key on its own is deliberately not enough — plenty of people leave one exported, and ` +
    `having a key is not the same as deciding to spend. Nothing ran and nothing was billed.\n` +
    `This is about what the run REACHES, not which --tier you typed: --runtime opencode and ` +
    `--provider both spend on somebody's provider account whatever tier is beside them.`
  );
}

/**
 * The message a paid-provider run gets when the flag is set and no key is
 * present. This one is a runner ERROR rather than a stop-before-starting: the
 * person asked for a paid run, so silence would look like coverage.
 *
 * @returns The runner-error message.
 */
export function paidProviderNoKeyMessage(): string {
  return (
    `This run was armed to spend with ${PAID_PROVIDER_OPT_IN_VAR}=1, but ` +
    `${OPENROUTER_API_KEY_VAR} is not set, so there is nothing to reach a model with. ` +
    `Set it to an OpenRouter API key. This is reported as an error rather than a skip on ` +
    `purpose: a run that claims to have covered these cases must never report a pass it did ` +
    `not earn.`
  );
}

/**
 * The message a paid-provider run gets when it is asked for the docker
 * isolation tier.
 *
 * The docker tier's containers have NO network by design (ADR 260725-133222),
 * and this tier's whole job is to reach openrouter.ai. Refused loudly rather
 * than degraded quietly, because a silent fall back to child-process would give
 * an operator who asked for containment a turn that ran on the bare host.
 *
 * @returns The runner-error message.
 */
export function paidProviderRefusesDockerMessage(): string {
  return (
    'A run that reaches a paid provider cannot use the docker isolation tier: eval containers have no ' +
    'network at all (that is the containment they exist to provide), and this tier has to reach ' +
    'openrouter.ai. Run it with `--isolation child-process`, which is what it uses by default.'
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
