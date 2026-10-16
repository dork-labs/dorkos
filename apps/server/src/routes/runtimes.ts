/**
 * Runtime connect + provisioning routes, mounted at `/api/runtimes`.
 *
 * The forward-looking home for per-runtime connect actions (ADR-0318): opt-in
 * OpenCode provisioning (ADR-0317), the native paste-key + delegated-login
 * endpoints (T1 task 2.3), the OpenRouter Gateway paste-key/OAuth-PKCE/catalog
 * endpoints (task 2.6), and zero-auth Ollama detection (task 2.7). Every action
 * here is host-mutating or secret-bearing, so all endpoints are loopback-only and
 * no endpoint ever echoes or logs a secret.
 *
 * @module routes/runtimes
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { provisionOpenCode } from '../services/runtimes/opencode/providers/provision.js';
import { provisionCodex } from '../services/runtimes/codex/provision.js';
import { provisionClaudeCode } from '../services/runtimes/claude-code/tooling/provision.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  readOpenCodeDirectSetup,
  readRuntimeKeyStatus,
  checkProviderCredential,
  checkRuntimeCredential,
} from '../services/runtimes/connect/credentials.js';
import { ConnectError } from '../services/runtimes/connect/connect-error.js';
import {
  delegateRuntimeLogin,
  LOGIN_RUNTIME_TYPES,
} from '../services/runtimes/connect/delegated-login.js';
import { resolveAccountRootForSession } from '../services/runtimes/connect/resolve-session-account.js';
import {
  buildAuthorizeUrl,
  handleOpenRouterCallback,
  openRouterOAuthStore,
  storeOpenRouterKeyReference,
  OpenRouterError,
} from '../services/runtimes/opencode/providers/openrouter.js';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { OLLAMA_TAG_PATTERN } from '@dorkos/shared/runtime-connect';
import { detectOllama, pullOllamaModel } from '../services/runtimes/opencode/providers/ollama.js';
import {
  provisionOllama,
  detectOllamaInstallMethod,
} from '../services/runtimes/opencode/providers/ollama-provision.js';
import {
  assessInstalledModels,
  assessOllamaModels,
  DEFAULT_OLLAMA_MODEL_ID,
} from '../services/runtimes/opencode/providers/ollama-catalog.js';
import {
  DismissFoundFolderRequestSchema,
  LEDGER_RUNTIMES,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import {
  AccountUsageUnavailableError,
  probeAccount,
  UnknownAccountError,
} from '../services/runtimes/claude-code/accounts/account-probe.js';
import {
  findUnregisteredClaudeFolders,
  planDismissFoundFolder,
} from '../services/runtimes/claude-code/accounts/found-claude-folders.js';
import { configManager } from '../services/core/config-manager.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { logger } from '../lib/logger.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { mountAccountEligibilityRoutes } from './runtimes-account-eligibility.js';
import {
  refuseNonLocalProvisioning,
  refuseNonLoopback,
  requestProtocol,
  streamSseAction,
} from './runtimes-http.js';
import { createDoeSetupRoutes } from './runtimes-doe-setup.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';

const SecretBodySchema = z.object({ secret: z.string().min(1) });
const OpenRouterKeyBodySchema = z.object({ key: z.string().min(1) });
const ProviderCredentialBodySchema = z.object({
  providerId: z.string().min(1),
  // An EMPTY string is a real request, not a malformed one: it means "keep the
  // key you already have, I only changed the address". The service decides
  // whether there is a saved key to keep, and 400s when there is not.
  secret: z.string(),
  baseURL: z.string().nullable().optional(),
});
/** A key to TRY: omitted means "try the key that is already saved". */
const CheckProviderBodySchema = z.object({
  providerId: z.string().min(1),
  secret: z.string().min(1).optional(),
  baseURL: z.string().nullable().optional(),
});
/** A runtime key to TRY: omitted means "try the key that is already saved". */
const CheckSecretBodySchema = z.object({ secret: z.string().min(1).optional() });
const OllamaPullBodySchema = z.object({
  // Any syntactically valid Ollama tag — DorkOS pulls what you name, curated or
  // not (spec §3). The regex only rejects malformed input, never uncurated tags.
  model: z.string().min(1).regex(OLLAMA_TAG_PATTERN).optional(),
});
const LoginBodySchema = z.object({
  // `claude-code` only: pin the login to this account root instead of the
  // one DorkOS runs new sessions on (DOR-1652). Shape-validated here;
  // `delegateRuntimeLogin` rejects it outright for `codex` (no config-dir
  // concept there) and, for `claude-code`, against the known account roots —
  // both before anything spawns.
  accountRoot: z.string().min(1).optional(),
  // Sign back into the account THIS session is bound to (DOR-1651). Preferred
  // over `accountRoot` because only the server can answer it correctly for a
  // session whose first turn failed before writing a transcript — the client's
  // `Session.account` is derived from that transcript and is absent exactly
  // then. See `resolveAccountRootForSession`.
  sessionId: z.string().min(1).optional(),
});

/** A runtime's on-demand provisioning function (streams progress, resolves to a result). */
type ProvisionFn = (
  onProgress: (progress: RuntimeProvisionProgress) => void
) => Promise<RuntimeProvisionResult>;

/**
 * Stream an on-demand runtime install over SSE. Every provisioning runtime
 * shares this handler — the SSE frame contract is identical across runtimes so
 * the client renders one flow. Loopback-only (host-mutating).
 *
 * @param c - The request's context (loopback-checked before any output).
 * @param provision - The runtime's provisioning function.
 * @param runtimeLabel - Display name for the defensive fallback error message.
 * @returns The refusal, or the stream's marker once it has ended.
 */
async function streamRuntimeProvision(
  c: Context<ApiEnv>,
  provision: ProvisionFn,
  runtimeLabel: string
): Promise<Response> {
  const refused = refuseNonLocalProvisioning(c);
  if (refused) return refused;

  return streamSseAction(
    c,
    provision,
    { ok: false, error: `Could not install ${runtimeLabel}. Please try again.` },
    `[Runtimes] ${runtimeLabel} provisioning failed unexpectedly`
  );
}

/** What the runtime routes read from the running server. */
export interface RuntimesRouterDeps {
  /** Where account-rule changes are recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
}

/**
 * Create the runtime connect and provisioning routes.
 *
 * @param deps - See {@link RuntimesRouterDeps}.
 * @returns The routes, to mount at `/api/runtimes`.
 */
export function createRuntimesRoutes(deps: RuntimesRouterDeps = {}): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // Which Claude accounts may work in which projects (spec `flow-multiproject`
  // §8.6), in their own module; mounted first so no `/:type/...` pattern below
  // can shadow them.
  mountAccountEligibilityRoutes(router, deps.activity);

  /**
   * POST /api/runtimes/opencode/provision — opt-in, on-demand OpenCode install.
   *
   * Streams install progress as `progress` SSE frames and a terminal `result`
   * frame carrying the {@link provisionOpenCode} outcome. Loopback-only.
   */
  router.post('/opencode/provision', (c) =>
    streamRuntimeProvision(c, provisionOpenCode, 'OpenCode')
  );

  /**
   * POST /api/runtimes/codex/provision — opt-in, on-demand Codex install (ADR-0317).
   *
   * The one-click fallback when the SDK-vendored Codex binary is absent. Shares the
   * exact SSE frame contract as the OpenCode endpoint: `progress` frames then a
   * terminal `result` frame carrying the {@link provisionCodex} outcome. Loopback-only.
   */
  router.post('/codex/provision', (c) => streamRuntimeProvision(c, provisionCodex, 'Codex'));

  /**
   * POST /api/runtimes/claude-code/provision — opt-in, on-demand Claude Code install.
   *
   * The endpoint behind the "Install Claude" action the readiness projection
   * already offered when no `claude` binary resolves; without it that button
   * answered 404 and looked to the person like nothing happening (DOR-1334 / F4).
   * Installs the SDK's per-platform binary package, version-locked to the SDK pin.
   * Same SSE frame contract as the codex/opencode endpoints. Loopback-only.
   */
  router.post('/claude-code/provision', (c) =>
    streamRuntimeProvision(c, provisionClaudeCode, 'Claude Code')
  );

  // --- OpenRouter (OpenCode Gateway) -----------------------------------------
  // Registered before the generic `/:type/*` routes for readability; the path
  // shapes never overlap (these are 3+ segments, the generic ones are 2).

  /**
   * POST /api/runtimes/opencode/openrouter/key — validate + store an OpenRouter
   * key (paste-key path). Returns only `{ ok }` (+ honest error) — never the key.
   */
  router.post('/opencode/openrouter/key', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const parsed = OpenRouterKeyBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'An OpenRouter key is required.' }, 400);
    }
    try {
      await storeOpenRouterKeyReference(parsed.data.key);
      return c.json({ ok: true });
    } catch (err) {
      // Invalid key / unreachable OpenRouter are expected outcomes — return an
      // honest result, not an exception. Never surface the key.
      if (err instanceof OpenRouterError) {
        return c.json({ ok: false, error: err.message });
      }
      logger.error('[Runtimes] OpenRouter key store failed unexpectedly');
      return c.json({ ok: false, error: 'Could not save the OpenRouter key.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/opencode/openrouter/oauth/start — begin OAuth-PKCE. Mints
   * a verifier + state (verifier stays server-side) and returns the authorize URL
   * (with a loopback callback embedding the state) plus the state to poll.
   */
  router.post('/opencode/openrouter/oauth/start', (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const { state, challenge } = openRouterOAuthStore.start();
    const host = honoRequestFacts(c).headers.host;
    const callbackUrl = `${requestProtocol(c)}://${host}/api/runtimes/opencode/openrouter/oauth/callback?state=${state}`;
    return c.json({ authorizeUrl: buildAuthorizeUrl(callbackUrl, challenge), state });
  });

  /**
   * GET /api/runtimes/opencode/openrouter/oauth/callback — the loopback landing the
   * browser is redirected to after authorization. Validates state, exchanges the
   * code for a scoped key, stores it by reference, and renders a plain page telling
   * the user to return to DorkOS. Loopback-only (the user's own browser hits it).
   */
  router.get('/opencode/openrouter/oauth/callback', async (c) => {
    if (!isAtThisComputer(honoRequestFacts(c))) {
      return c.body('Not available.', 403, { 'Content-Type': HTML_TYPE });
    }
    const query = readQuery(c);
    const state = typeof query.state === 'string' ? query.state : undefined;
    const code = typeof query.code === 'string' ? query.code : undefined;
    const error = typeof query.error === 'string' ? query.error : undefined;
    const result = await handleOpenRouterCallback({ state, code, error });
    return c.body(
      renderCallbackPage(result.status === 'connected', result.error),
      result.status === 'connected' ? 200 : 400,
      { 'Content-Type': HTML_TYPE }
    );
  });

  /**
   * GET /api/runtimes/opencode/openrouter/oauth/status — poll an in-flight flow's
   * status by `state` (the client polls after opening the authorize URL).
   */
  router.get('/opencode/openrouter/oauth/status', (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const query = readQuery(c);
    const state = typeof query.state === 'string' ? query.state : '';
    return c.json(openRouterOAuthStore.status(state));
  });

  // --- Ollama (OpenCode Local) -----------------------------------------------

  /**
   * GET /api/runtimes/opencode/ollama — zero-auth local Ollama detection: running
   * state + pulled models, bounded so an absent/hung Ollama degrades fast. Also
   * returns the installed models with an honest fit verdict per model (spec §3).
   */
  router.get('/opencode/ollama', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const status = await detectOllama();
    const [installed, installMethod] = await Promise.all([
      assessInstalledModels(status.models),
      detectOllamaInstallMethod(),
    ]);
    return c.json({ ...status, installed, installMethod });
  });

  /**
   * GET /api/runtimes/opencode/ollama/models — the curated coding-model catalog for
   * the guided pull, each entry assessed against this machine's hardware with an
   * honest `runs-well | may-be-slow | too-large` verdict. Static heuristic, not a
   * benchmark; never claims certainty.
   */
  router.get('/opencode/ollama/models', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    return c.json(await assessOllamaModels());
  });

  /**
   * POST /api/runtimes/opencode/ollama/pull — trigger a single Ollama pull and
   * STREAM download progress (mirrors the provision endpoint's SSE shape: `progress`
   * frames then a terminal `result`). Loopback-only.
   *
   * Any syntactically valid Ollama tag is accepted, curated or not (spec §3) — a
   * non-curated pull skips the curated pre-gate; a malformed tag is rejected up
   * front (before the stream opens). Post-pull fit verdicts are delivered by the
   * detection endpoint's installed list, not this stream. DorkOS never owns or
   * manages Ollama's library.
   */
  router.post('/opencode/ollama/pull', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;

    const parsed = OllamaPullBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'That is not a valid Ollama model name.' }, 400);
    }
    const model = parsed.data.model ?? DEFAULT_OLLAMA_MODEL_ID;

    return streamSseAction(
      c,
      (onProgress) => pullOllamaModel(model, onProgress),
      { ok: false, model, error: 'Could not pull the model. Please try again.' },
      '[Runtimes] Ollama pull failed unexpectedly'
    );
  });

  /**
   * POST /api/runtimes/opencode/ollama/provision — guided, password-free Ollama
   * install (spec §13). STREAMS install progress (mirrors the provision endpoint's
   * SSE shape: `progress` frames then a terminal `result`); the terminal result
   * carries the resolved install method and a fresh detection re-probe. macOS via
   * Homebrew, Windows via winget; `manual` platforms resolve to an honest
   * `ok: false` (the client shows the copyable command). Loopback-only, no sudo.
   */
  router.post('/opencode/ollama/provision', async (c) => {
    const refused = refuseNonLocalProvisioning(c);
    if (refused) return refused;

    return streamSseAction(
      c,
      provisionOllama,
      { ok: false, installMethod: 'manual', error: 'Could not install Ollama. Please try again.' },
      '[Runtimes] Ollama install failed unexpectedly'
    );
  });

  /**
   * GET /api/runtimes/opencode/provider — what the "your own key" form should show
   * when it is reopened: the saved service, its base URL, and whether a key is
   * already saved (last FOUR characters only, never more). Loopback-only.
   *
   * Reopening that form used to show three empty fields, which reads as "nothing
   * is saved" even when something was (DOR-2123, report FB-48).
   */
  router.get('/opencode/provider', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    try {
      return c.json(await readOpenCodeDirectSetup());
    } catch {
      // Never surface a store/config failure's detail — it can carry a path.
      logger.error('[Runtimes] Reading the saved key setup failed unexpectedly');
      return c.json({ error: 'Could not read your saved settings.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/opencode/provider/credential/check — try a key against the
   * service it belongs to and save NOTHING. Backs the Test button, and runs the
   * same check a save runs. An omitted `secret` tries the key already saved for
   * that service. Loopback-only; the response never echoes the key.
   *
   * A key that is not accepted is a 200 carrying `{ ok: false, … }`, not an error
   * status: the request succeeded and the answer is "no", which is exactly what
   * the person asked for.
   */
  router.post('/opencode/provider/credential/check', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const parsed = CheckProviderBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json({ error: 'A provider id is required.' }, 400);
    }
    try {
      const result = await checkProviderCredential({
        providerId: parsed.data.providerId,
        secret: parsed.data.secret ?? null,
        baseURL: parsed.data.baseURL ?? null,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      logger.error('[Runtimes] Provider key check failed unexpectedly');
      return c.json({ error: 'Could not check the key.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/opencode/provider/credential — the OpenCode Direct-provider
   * path: store an OpenAI-compatible provider's key by reference, select it as
   * OpenCode's provider, and record an optional base URL. Persists only the
   * reference; the response never echoes the secret. Loopback-only. (Distinct from
   * the generic `/:type/credential` route, which is keyed by runtime type — this is
   * keyed by an arbitrary provider id.)
   */
  router.post('/opencode/provider/credential', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const parsed = ProviderCredentialBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'A provider id and API key are required.' }, 400);
    }
    try {
      const { ref } = await storeProviderCredential({
        providerId: parsed.data.providerId,
        secret: parsed.data.secret,
        baseURL: parsed.data.baseURL ?? null,
      });
      return c.json({ ref });
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      // Never include the secret or a raw stack in the response or log.
      logger.error('[Runtimes] Provider credential store failed unexpectedly');
      return c.json({ error: 'Could not save the provider key.' }, 500);
    }
  });

  // The DorkOS model setup, in its own module. Mounted before the generic
  // `/:type/...` routes below, as it was, so `POST /doe/credential` is never
  // taken for a runtime named `doe`.
  router.route('/doe', createDoeSetupRoutes());

  // --- Generic per-runtime connect (Claude, Codex) ---------------------------

  /**
   * GET /api/runtimes/:runtime/accounts/usage — how much of each of this
   * runtime's accounts is used, from the usage store's memory (spec
   * `claude-account-fleet` D2). Registered accounts in registry order, the
   * machine-wide `default` when it stands alone, then folders that are neither.
   * Any runtime slug that keeps a ledger; anything else is a 400.
   */
  router.get('/:runtime/accounts/usage', (c) => {
    const runtime = c.req.param('runtime');
    if (!(LEDGER_RUNTIMES as readonly string[]).includes(runtime)) {
      return c.json({ error: `Unknown runtime "${runtime}".` }, 400);
    }
    const store = getAccountUsageStore();
    if (!store) return c.json({ error: 'Account usage is not available yet.' }, 503);
    return c.json({ accounts: store.list(runtime as LedgerRuntime) });
  });

  /**
   * POST /api/runtimes/claude-code/accounts/:id/probe — read an idle Claude
   * account's usage without running a turn (spec `claude-account-fleet` D3). The
   * id is a registry id or `default`. Always 200 once the account is known: a
   * probe that could not read anything says so in `probe` and records nothing.
   *
   * It starts the Claude binary in that account's folder, so it holds a person's
   * bar: with login on, a signed-in person; and never a caller that names itself
   * an agent. Agents check an account through the `accounts_probe` MCP tool,
   * which runs through the tool gate like every other `act` tool.
   */
  router.post('/claude-code/accounts/:id/probe', async (c) => {
    const caller = honoRequestFacts(c);
    const cookieRefusal = requireOperatorCookieUnderLogin(caller, "an account's usage check");
    if (cookieRefusal) {
      return c.json(
        { error: cookieRefusal.error, code: cookieRefusal.code },
        cookieRefusal.status as ContentfulStatusCode
      );
    }
    if (!trustedCaller(readCallerAuthority(caller))) {
      return c.json(
        {
          error:
            'Only a person can start an account check here. Agents use the accounts_probe tool.',
          code: 'PERSON_ONLY',
        },
        403
      );
    }
    try {
      return c.json(await probeAccount(c.req.param('id')));
    } catch (err) {
      if (err instanceof UnknownAccountError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      if (err instanceof AccountUsageUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });

  /**
   * GET /api/runtimes/claude-code/accounts/found — the Claude account folders on
   * this computer that are not registered, not the machine default and not
   * dismissed (spec `claude-account-ui` §7.4). Read-only: it stats folders and
   * never opens a file.
   *
   * Readable by any caller the API already lets in, with no operator bar: the
   * answer is folder paths under the home folder, the same class of fact
   * `GET /api/config` and the agent-facing config snapshot already disclose
   * (`runtimes.claudeCode.accounts[].path`, `dismissedFolders`).
   */
  router.get('/claude-code/accounts/found', (c) => {
    try {
      const folders = findUnregisteredClaudeFolders({ runtimes: configManager.get('runtimes') });
      return c.json({ folders });
    } catch (err) {
      logger.error('[Runtimes] Could not look for Claude account folders', { err: String(err) });
      return c.json({ error: 'Could not look for Claude account folders.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/claude-code/accounts/found/dismiss — stop offering one
   * found folder, across restarts (spec `claude-account-ui` §7.4). Appends the
   * folder, in comparable form, to `runtimes.claudeCode.dismissedFolders` in one
   * synchronous read-modify-write, so two dismissals in a row both stick. A
   * folder that is already registered or dismissed answers 204 too (another tab
   * got there first); any other folder the list does not offer is a 400.
   *
   * `dismissedFolders` is operator-only, and this route is its only writer, so
   * it holds the same two bars `PATCH /api/config` holds for such a leaf: with
   * login on, a signed-in person; and never a caller that names itself an agent.
   *
   * The write is `configManager.setDot` on purpose, not `applyConfigPatch`: this
   * is a purpose-built writer in `config-write.ts`'s sense, moving one fixed leaf
   * as part of its own job, so it keeps its own gate (the two bars above) and
   * leaves a `logConfigWrite` line instead of re-running the path policy.
   */
  router.post('/claude-code/accounts/found/dismiss', (c) => {
    const caller = honoRequestFacts(c);
    const cookieRefusal = requireOperatorCookieUnderLogin(
      caller,
      'which account folders are hidden'
    );
    if (cookieRefusal) {
      return c.json(
        { error: cookieRefusal.error, code: cookieRefusal.code },
        cookieRefusal.status as ContentfulStatusCode
      );
    }
    if (!trustedCaller(readCallerAuthority(caller))) {
      return c.json(
        {
          error: OPERATOR_ONLY_CONFIG_ERROR,
          code: OPERATOR_ONLY_CONFIG_CODE,
          message: 'Only a person can hide an account folder.',
        },
        403
      );
    }
    const parsed = DismissFoundFolderRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json({ error: 'Send the folder to hide as `path`.' }, 400);
    }
    try {
      const plan = planDismissFoundFolder(parsed.data.path, {
        runtimes: configManager.get('runtimes'),
      });
      if (plan.outcome === 'not-a-candidate') {
        return c.json(
          { error: 'That folder is not one of the account folders found on this computer.' },
          400
        );
      }
      if (plan.outcome === 'save') {
        const before = configManager.get('runtimes');
        configManager.setDot('runtimes.claudeCode.dismissedFolders', plan.dismissed);
        logConfigWrite(
          'the found-folders route',
          'runtimes',
          before,
          configManager.get('runtimes')
        );
      }
      return c.body(null, 204);
    } catch (err) {
      logger.error('[Runtimes] Could not hide a Claude account folder', { err: String(err) });
      return c.json({ error: 'Could not hide that folder. Try again.' }, 500);
    }
  });

  /**
   * GET /api/runtimes/:type/credential — whether this runtime's own key is already
   * saved, and its last FOUR characters when it is. Never more of the key than
   * that. Loopback-only.
   */
  router.get('/:type/credential', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    try {
      return c.json(await readRuntimeKeyStatus(c.req.param('type')));
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      logger.error('[Runtimes] Reading the saved key status failed unexpectedly');
      return c.json({ error: 'Could not read your saved key.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/:type/credential/check — try this runtime's key against the
   * service that issues it and save NOTHING. An omitted `secret` tries the saved
   * key, which only Claude Code holds. Loopback-only; never echoes the key.
   */
  router.post('/:type/credential/check', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const type = c.req.param('type');
    const parsed = CheckSecretBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json({ error: 'An API key must be a string.' }, 400);
    }
    try {
      const result = await checkRuntimeCredential(type, parsed.data.secret ?? null);
      return c.json(result);
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      logger.error('[Runtimes] Credential check failed unexpectedly', { type });
      return c.json({ error: 'Could not check the API key.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/:type/credential — store a runtime's native API key
   * (paste-key path). Persists only the reference; the response never echoes the
   * secret. Loopback-only.
   */
  router.post('/:type/credential', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const type = c.req.param('type');
    const parsed = SecretBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'An API key is required.' }, 400);
    }
    try {
      const { ref } = await storeRuntimeCredential(type, parsed.data.secret);
      return c.json({ ref });
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      // Never include the secret or a raw stack in the response or log.
      logger.error('[Runtimes] Credential store failed unexpectedly', { type });
      return c.json({ error: 'Could not save the API key.' }, 500);
    }
  });

  /**
   * POST /api/runtimes/:type/login — delegate the vendor CLI login terminal-free
   * and detect completion (bounded). Returns `{ ok, error? }`. Loopback-only.
   *
   * Body is optional (Express 5 leaves `req.body` `undefined` on an empty POST):
   * an omitted body signs in the account DorkOS runs new sessions on.
   *
   * Account precedence, highest first:
   *
   * 1. `{ sessionId }` — the account THAT session is bound to, resolved through
   *    the launch ladder the server already owns (DOR-1651). Highest because it
   *    is the only rung that is right for a session whose first turn failed
   *    before a transcript existed; the client cannot compute it.
   * 2. `{ accountRoot }` — an explicit pin, for callers with no session
   *    (DOR-1652's seam).
   * 3. Neither — the account DorkOS runs new sessions on.
   *
   * A `sessionId` that resolves to nothing falls through to `accountRoot`, then
   * to the default: an unknown session degrades the pin, it never refuses the
   * sign-in. `delegateRuntimeLogin` owns the rest of the validation — it rejects
   * a pin outright for any type other than `claude-code`, and, for `claude-code`,
   * against the known account roots, both before anything spawns.
   */
  router.post('/:type/login', async (c) => {
    const refused = refuseNonLoopback(c);
    if (refused) return refused;
    const type = c.req.param('type');
    if (!(LOGIN_RUNTIME_TYPES as readonly string[]).includes(type)) {
      return c.json(
        { ok: false, error: `${runtimeDisplayName(type)} does not support sign-in.` },
        400
      );
    }
    const parsed = LoginBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'accountRoot and sessionId must be non-empty strings.' },
        400
      );
    }
    const fromSession = parsed.data.sessionId
      ? await resolveAccountRootForSession(parsed.data.sessionId)
      : undefined;
    const accountRoot = fromSession ?? parsed.data.accountRoot;
    const result = await delegateRuntimeLogin(type, { accountRoot });
    return c.json(result);
  });

  return router;
}

/**
 * Escape HTML-special characters so an interpolated value can never inject markup
 * into the callback page. All current callers pass fixed strings, but this keeps
 * the same-origin page safe against reflected XSS if a future value is ever
 * user-derived.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The OAuth landing's type, as Express's `send` set it for a string body. */
const HTML_TYPE = 'text/html; charset=utf-8';

/** Minimal HTML for the OAuth callback landing (no secret, no external assets). */
function renderCallbackPage(connected: boolean, error?: string): string {
  const title = escapeHtml(connected ? 'Connected to OpenRouter' : 'Sign-in failed');
  const body = escapeHtml(
    connected
      ? 'You can close this tab and return to DorkOS.'
      : (error ?? 'Please return to DorkOS and try again.')
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a;"><h1 style="font-size: 1.25rem;">${title}</h1><p style="color: #555;">${body}</p></body></html>`;
}
