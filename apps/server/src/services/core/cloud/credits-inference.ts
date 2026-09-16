/**
 * Pointing a runtime at DorkOS credits for inference.
 *
 * The endpoint speaks the verbatim vendor protocols, so no runtime needs a new
 * client — what each one needs is a base URL and a token, and both are runtime
 * values this module obtains from `POST /v1/inference/tokens`. Nothing here
 * bakes in a host: the endpoints arrive on the wire.
 *
 * ## The flag, and the key beside it
 *
 * This path spends money, so it follows the repo's flag-beside-its-own-key rule
 * (`AGENTS.md`, "Commands"): the FLAG is the decision and the KEY is the
 * instrument, and neither alone arms anything.
 *
 * - Flag: `DORKOS_CLOUD_CREDITS` — read once at MODULE scope, so no other
 *   file's `vi.stubEnv` can arm it, and absent by default.
 * - Key: the existing cloud-link instance credential (`cloud.instanceToken`).
 *   Plenty of installs are linked without having decided to spend, so being
 *   linked arms nothing on its own.
 *
 * With the flag off — which is every install until somebody sets it — every
 * function here is inert and {@link creditsTurnEnv} returns an empty object, so
 * a turn launches exactly as it does today.
 *
 * ## The token is a credential
 *
 * It is held in memory for the life of the process and never written to config,
 * never logged, and never sent to the client. That is also what keeps the
 * "rotate only at a process boundary" rule: nothing here runs on a timer, and a
 * turn never mints — {@link creditsTurnEnv} is synchronous and reads only what
 * {@link primeCreditsInference} already obtained. Persisting it into the
 * encrypted credential store is a follow-up, not a gap this module papers over.
 *
 * @module services/core/cloud/credits-inference
 */
import { InferenceTokenSchema, V1_ROUTES, type InferenceToken } from '@dork-labs/cloud-api';
import { env } from '../../../env.js';
import { logger, logError } from '../../../lib/logger.js';
import { createCloudV1Client } from './v1-client.js';

/** The environment variable that decides whether credits may be spent. */
export const CREDITS_FLAG_NAME = 'DORKOS_CLOUD_CREDITS';

/**
 * Whether a flag value reads as "on".
 *
 * Exported so tests can exercise the parsing without reaching for the
 * module-scope read, which they deliberately cannot change.
 *
 * @param value - The raw environment value, or `undefined`.
 */
export function isCreditsFlagOn(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

/**
 * The flag, read ONCE at module scope.
 *
 * Every money path in this repo does this for the same reason: a flag re-read
 * per call can be armed by a stray `vi.stubEnv` in an unrelated test file, and a
 * money path armed by accident is the one failure mode that costs somebody
 * something real.
 */
const CREDITS_ENABLED = isCreditsFlagOn(env.DORKOS_CLOUD_CREDITS);

/** Whether the credits path is armed for this process. */
export function creditsFlagEnabled(): boolean {
  return CREDITS_ENABLED;
}

/** The minted token, held only in memory. `null` until something primes it. */
let minted: InferenceToken | null = null;

/** Injectable clock so the expiry check is testable without waiting. */
let now: () => number = () => Date.now();

/**
 * Replace the module's in-memory state. Test seam only — production primes
 * through {@link primeCreditsInference}.
 *
 * @param state - The token to hold (or `null` to clear) and an optional clock.
 * @internal
 */
export function __setCreditsStateForTests(state: {
  token: InferenceToken | null;
  now?: () => number;
}): void {
  minted = state.token;
  if (state.now) now = state.now;
}

/** Whether the held token is present and still inside its validity window. */
function live(): InferenceToken | null {
  if (minted === null) return null;
  return Date.parse(minted.expiresAt) > now() ? minted : null;
}

/**
 * Mint an inference token and hold it for this process, returning whether the
 * credits path is now usable.
 *
 * A no-op returning `false` when the flag is off or the instance is not linked.
 * Failures are logged and swallowed: a cloud outage degrades the paid
 * affordance and never blocks local work.
 *
 * The token is minted per PROCESS rather than per agent, so no `agentRef` is
 * sent. Per-agent attribution needs the reference to travel on each request
 * instead — a LOCAL agent has no cloud seat and can still spend credits, so it
 * keys on an opaque agent reference and not on a seat — and the header slot that
 * carries it is a listed follow-up.
 *
 * @param instanceId - This instance's opaque identifier, for attribution.
 */
export async function primeCreditsInference(instanceId: string): Promise<boolean> {
  if (!CREDITS_ENABLED) return false;
  const client = createCloudV1Client();
  if (client === null) return false;
  try {
    minted = await client.post(V1_ROUTES.inferenceTokens, InferenceTokenSchema, {
      body: { instanceId },
    });
    return true;
  } catch (error) {
    // Never log the body: a mint response carries a credential.
    logger.warn(
      '[Cloud] Could not obtain an inference token; credits stay unselected',
      logError(error)
    );
    return false;
  }
}

/**
 * The environment a turn launches with when credits are selected, or an empty
 * object when they are not.
 *
 * Synchronous on purpose — it is read on the launch path, and a launch that
 * waited on the network would turn a cloud hiccup into a stalled turn.
 *
 * Only `claude-code` is wired here, and that is a deliberate stopping point
 * rather than an omission: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are
 * already allow-listed in the environment catalog's `Claude common` profile that
 * `purpose: turn` selects, so pointing Claude Code at the endpoint needs no
 * change to what a child process may see. The other two runtimes each need a
 * design decision first and are tracked as follow-ups — see
 * {@link creditsWiringReport}.
 *
 * @param runtime - The runtime about to launch.
 */
export function creditsTurnEnv(runtime: string): Record<string, string> {
  return creditsEnvFor(live(), runtime, CREDITS_ENABLED);
}

/**
 * The pure core of {@link creditsTurnEnv}: what a runtime's environment gains
 * from a held token.
 *
 * Extracted so the ON behaviour can be tested at all. The flag is read once at
 * module scope and cannot be stubbed — which is the property that protects the
 * money path, and also the reason a test can never reach the interesting branch
 * through the wrapper. This function takes the decision as an argument instead,
 * and production has exactly one caller that supplies the module constant.
 *
 * @param token - The held inference token, or `null` when there is none.
 * @param runtime - The runtime about to launch.
 * @param enabled - Whether the credits flag is on.
 */
export function creditsEnvFor(
  token: InferenceToken | null,
  runtime: string,
  enabled: boolean
): Record<string, string> {
  if (!enabled || token === null) return {};
  if (!CREDITS_WIRED_RUNTIMES.has(runtime)) return {};
  return {
    ANTHROPIC_BASE_URL: token.endpoints.anthropicMessages,
    ANTHROPIC_AUTH_TOKEN: token.token,
  };
}

/**
 * The runtimes {@link creditsEnvFor} actually contributes an environment for.
 *
 * The ONE list, read by both the wiring and the report, so the app cannot tell
 * somebody a runtime is wired while contributing nothing to its turns.
 */
const CREDITS_WIRED_RUNTIMES = new Set<string>(['claude-code']);

/** How far a runtime's credits wiring has got. */
export type CreditsRuntimeState = 'wired' | 'follow-up';

/** What the app can honestly say about the credits path right now. */
export interface CreditsWiringReport {
  /** Whether the flag is on for this process. */
  enabled: boolean;
  /** Whether a live token is held. Never the token itself. */
  ready: boolean;
  /** Per-runtime state, so a surface can say what actually works. */
  runtimes: Record<'claude-code' | 'opencode' | 'codex', CreditsRuntimeState>;
}

/**
 * A credential-free description of the credits path, safe to hand the client.
 *
 * It carries no token, no endpoint and no amount — only whether the path is
 * armed and which runtimes it reaches.
 */
export function creditsWiringReport(): CreditsWiringReport {
  // DERIVED from the wiring, never asserted beside it. A hardcoded map would
  // keep telling somebody their turns run on credits after the wiring that made
  // that true was deleted — which, on a money path, is the worst thing a status
  // line can do.
  //
  // The two follow-ups are follow-ups for stated reasons.
  // `runtimes.opencode.baseURL` is written to `OPENAI_BASE_URL`
  // unconditionally, outside the provider branch, so wiring credits there would
  // take a BYOK OpenAI-compatible endpoint away from anyone holding one, and
  // anything shipped free stays free. Codex needs a `model_providers` entry
  // written into the DorkOS-owned `$CODEX_HOME/config.toml` plus a new name on
  // its env allow-list — a file this app has deliberately never parsed.
  const state = (runtime: string): CreditsRuntimeState =>
    CREDITS_WIRED_RUNTIMES.has(runtime) ? 'wired' : 'follow-up';
  return {
    enabled: CREDITS_ENABLED,
    ready: live() !== null,
    runtimes: {
      'claude-code': state('claude-code'),
      opencode: state('opencode'),
      codex: state('codex'),
    },
  };
}
