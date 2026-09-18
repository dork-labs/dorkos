/**
 * Try a key against the service it belongs to, before anything is saved
 * (DOR-2123, user report FB-48).
 *
 * Until this existed, DorkOS saved whatever was pasted. A typo, an expired key,
 * or a free-text service name nobody serves all saved cleanly and then failed on
 * the first turn, far away from the form that caused it — one report named the
 * service "Valut Cloud", which saved and then died at the env seam with no
 * mapping at all. Every save now runs through here first, and the Test button on
 * the form runs exactly the same check so what a person tests is what a save
 * will do.
 *
 * The check is one cheap authenticated read of the service's own model list: the
 * smallest call that proves a key is live without spending anything. It is
 * bounded, because an unreachable address must fail fast rather than hang the
 * form, and it never puts the key in a message, a log line, or a URL.
 *
 * @module services/runtimes/connect/check-credential
 */
import {
  OPENCODE_DIRECT_PROVIDERS,
  type CredentialCheckResult,
} from '@dorkos/shared/runtime-connect';
import { validateOpenRouterKey } from '../opencode/providers/openrouter.js';
import { ConnectError } from './connect-error.js';

/** Injectable `fetch` seam (defaults to global `fetch`); tests pass a mock. */
export type FetchFn = typeof fetch;

/**
 * Bound on one key check.
 *
 * Someone pressed Test or Save and is watching a spinner, so a few seconds of
 * patience is right — but a base URL pointing at nothing must come back as
 * "couldn't reach it" rather than sitting there. Eight seconds is long enough
 * for a cold TLS handshake to a busy service and short enough to stay a form.
 */
const CHECK_TIMEOUT_MS = 8_000;

/** Service id the OpenCode cloud path uses; checked through its own validator. */
const OPENROUTER_ID = 'openrouter';

/** How one service is asked whether a key is live. */
interface CheckSpec {
  /** Address used when the person entered no base URL. */
  defaultBaseURL: string;
  /** Path appended to the base URL for the cheap authenticated read. */
  probePath: string;
  /** Auth headers this service expects for that read. */
  headers: (secret: string) => Record<string, string>;
}

/**
 * Per-service probe shapes.
 *
 * `probePath` is paired with that service's own `defaultBaseURL`, which is why
 * OpenAI's is a bare `/models` (its default already ends in `/v1`) and
 * Anthropic's is `/v1/models` (its default does not). The path is appended
 * verbatim to whatever base URL is in play — no guessing at whether a person's
 * own address already carries a version segment, because guessing is how a
 * working address gets rewritten into a broken one.
 */
const CHECK_SPECS: Record<string, CheckSpec> = {
  openai: {
    defaultBaseURL: 'https://api.openai.com/v1',
    probePath: '/models',
    headers: (secret) => ({ Authorization: `Bearer ${secret}` }),
  },
  anthropic: {
    defaultBaseURL: 'https://api.anthropic.com',
    probePath: '/v1/models',
    headers: (secret) => ({ 'x-api-key': secret, 'anthropic-version': '2023-06-01' }),
  },
};

/**
 * Which service issues each runtime's own key. Claude Code keys are Anthropic
 * keys; Codex keys are OpenAI keys. Any other runtime has no key of its own.
 */
const RUNTIME_KEY_PROVIDERS: Record<string, string | undefined> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** Service ids a key may be checked against: the Direct list plus the cloud path. */
const ALLOWED_PROVIDER_IDS: readonly string[] = [
  ...OPENCODE_DIRECT_PROVIDERS.map((entry) => entry.id),
  OPENROUTER_ID,
];

/** A key to try, against one service at one address. */
export interface ProviderKeyCheckInput {
  /** Service id — one of the Direct list, or `openrouter`. */
  providerId: string;
  /** The raw key to try. Never logged, never echoed, never put in a URL. */
  secret: string;
  /** Base URL override; `null`/omitted uses the service's own default. */
  baseURL?: string | null;
}

/** Injectable `fetch` seam for the key checks (production defaults to global `fetch`). */
export interface CheckCredentialDeps {
  /** Replacement for global `fetch`; tests inject a stub so nothing leaves the machine. */
  fetchImpl?: FetchFn;
}

/**
 * Trim a base URL and drop any trailing slashes, so `https://host/v1/` and
 * `https://host/v1` probe the same address. Nothing else is rewritten: the
 * address a person entered is the address DorkOS talks to.
 *
 * @param baseURL - The raw base URL as entered.
 */
function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

/**
 * The human-readable host of a probe URL, for the failure message ("Couldn't
 * reach api.openai.com"). Falls back to the whole URL when it cannot be parsed,
 * which is itself a useful thing to show someone who mistyped an address.
 *
 * @param url - The probe URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Run one bounded `fetch`. Any throw — a refused connection, DNS failure, or
 * the timeout firing — is reported as unreachable rather than propagating, so a
 * key check always resolves to an answer a person can act on.
 *
 * @param fetchImpl - The `fetch` seam to call.
 * @param url - Fully-formed probe URL (never carries the key).
 * @param headers - Auth headers for the probe.
 */
async function probe(
  fetchImpl: FetchFn,
  url: string,
  headers: Record<string, string>
): Promise<CredentialCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: `Couldn’t reach ${hostOf(url)}. Check the base URL and whether you’re online.`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'rejected',
      message: 'That key was not accepted. Check it and try again.',
    };
  }
  return {
    ok: false,
    reason: 'unexpected',
    message: `${hostOf(url)} answered with ${response.status}. Try again in a minute.`,
  };
}

/**
 * Try a key against the service it belongs to. Nothing is stored, nothing is
 * spent — one authenticated read of the service's model list.
 *
 * @param input - Service id, the raw key, and an optional base URL override.
 * @param deps - Injectable `fetch` seam (production defaults to global `fetch`).
 * @returns Accepted, or an honest reason and a line a person can act on.
 * @throws {ConnectError} 400 when the service id is one DorkOS cannot pass a
 *   key to — the failure the free-text field used to defer until the first turn.
 */
export async function checkProviderKey(
  input: ProviderKeyCheckInput,
  deps: CheckCredentialDeps = {}
): Promise<CredentialCheckResult> {
  const providerId = input.providerId.trim();
  if (!ALLOWED_PROVIDER_IDS.includes(providerId)) {
    throw new ConnectError(
      `DorkOS can’t pass a key to "${providerId}". Choose OpenAI or Anthropic, or use an OpenAI-compatible base URL.`,
      400
    );
  }

  if (providerId === OPENROUTER_ID) {
    // The cloud path already owns its own validator (and its own bounded fetch);
    // reusing it keeps one answer for "is this OpenRouter key live".
    try {
      const valid = await validateOpenRouterKey(input.secret, deps);
      return valid
        ? { ok: true }
        : {
            ok: false,
            reason: 'rejected',
            message: 'That key was not accepted. Check it and try again.',
          };
    } catch {
      return {
        ok: false,
        reason: 'unreachable',
        message: 'Couldn’t reach openrouter.ai. Check whether you’re online and try again.',
      };
    }
  }

  const spec = CHECK_SPECS[providerId];
  // A blank address is not an address: an empty Advanced field means "use the
  // service's own", not "probe nothing".
  const entered = input.baseURL ? normalizeBaseURL(input.baseURL) : '';
  const base = entered.length > 0 ? entered : spec.defaultBaseURL;
  return probe(deps.fetchImpl ?? fetch, `${base}${spec.probePath}`, spec.headers(input.secret));
}

/**
 * Try a runtime's own pasted key against the service that issues it: Claude
 * keys against Anthropic, Codex keys against OpenAI.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param secret - The raw key to try. Never logged or echoed.
 * @param deps - Injectable `fetch` seam (production defaults to global `fetch`).
 * @returns Accepted, or an honest reason and a line a person can act on.
 * @throws {ConnectError} 400 when the runtime has no key of its own to check.
 */
export async function checkRuntimeKey(
  type: string,
  secret: string,
  deps: CheckCredentialDeps = {}
): Promise<CredentialCheckResult> {
  const providerId = RUNTIME_KEY_PROVIDERS[type];
  if (!providerId) {
    throw new ConnectError(`"${type}" does not support a native API key.`, 400);
  }
  return checkProviderKey({ providerId, secret }, deps);
}
