/**
 * Managed-MCP OAuth engine (DOR-942): DorkOS owns the full OAuth lifecycle for an
 * agent's OAuth-protected MCP servers and injects the access token as a bearer
 * header at session-injection time.
 *
 * Why DorkOS owns it: the Agent SDK's `mcpServers` config is static-headers-only
 * (no `authProvider`), so the subprocess can never run OAuth itself. This service
 * drives the MCP SDK's `auth()` on the acquisition side — discover → dynamic
 * client registration → authorization-code + PKCE → token exchange → refresh —
 * persists the token set encrypted, and keeps the current access token in a
 * **synchronous** in-memory cache ({@link McpAccessTokenCache}) that the injection
 * read path can consult without awaiting.
 *
 * Sign-in and refresh both go through the same `auth()` entry point, so they get
 * the same behaviour for free: the RFC 8707 `resource` parameter, the negotiated
 * scope, and the credential-invalidation retry that makes a revoked grant
 * recoverable. Concurrency between them is arbitrated by {@link McpTokenRefresher}.
 *
 * Two surfaces call in: the `mcp.signin`/`mcp.poll_signin` capabilities
 * ({@link startSignin}, {@link pollSignin}) and the loopback callback route
 * ({@link handleCallback}). Injection calls {@link getAccessToken}. Boot calls
 * {@link warm} to re-prime the cache from disk after a restart. Removing a server
 * or deleting an agent calls {@link forgetServer}/{@link forgetAgent}, which is
 * what makes "you can remove the server anytime" true of the credential too.
 *
 * @module services/mesh/agent-mcp-oauth-service
 */
import { randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import type { Logger } from '@dorkos/shared/logger';
import type { McpClientOrigin } from '@dorkos/shared/mesh-schemas';
import type { McpClientCredentials } from '@dorkos/shared/transport';

import {
  McpAccessTokenCache,
  type McpAccessTokenCacheDeps,
  type McpCacheRefreshVerdict,
} from './agent-mcp-access-token-cache.js';
import { McpOAuthFlowStore, type McpSigninStatus } from './agent-mcp-oauth-flow-store.js';
import {
  McpOAuthClientProvider,
  newSigninProgress,
  type McpSigninProgress,
  type McpOAuthProviderContext,
} from './agent-mcp-oauth-provider.js';
import { McpOAuthSecretStore, type StoredMcpTokens } from './agent-mcp-oauth-secret-store.js';
import { classifySigninFailure, McpSigninStartError } from './mcp-signin-failure.js';
import {
  McpTokenRefresher,
  attemptTokenRefresh,
  toCachedToken,
  withRequestTimeout,
} from './agent-mcp-token-refresher.js';
import {
  probeTarget,
  toolCountFrom,
  tokenWasRefused,
  type McpProbeTarget,
  type McpTargetProbe,
  type McpTargetProbeResult,
} from './agent-mcp-target-probe.js';
import type { McpSigninConnectedPort } from './mcp-signin-resume.js';

/** The dedicated encrypted store id for managed-MCP OAuth material (tokens + DCR client info). */
const MCP_OAUTH_STORE_ID = 'mcp-oauth';

/** The loopback callback path (`redirect_uri`); the route in `routes/mcp-oauth.ts` mounts here. */
export const MCP_OAUTH_CALLBACK_PATH = '/api/agents/mcp-oauth/callback';

/** Injectable `fetch` seam (defaults to global `fetch`); tests pass a mock OAuth provider fetch. */
export type FetchFn = typeof fetch;

/**
 * One `(agentId, serverName, serverUrl)` OAuth target — a managed server that
 * expects a token. The same shape a probe is asked about, named for this side.
 */
export type McpOAuthTarget = McpProbeTarget;

/**
 * The probe port and its result, re-exported so boot and the sign-in tests reach
 * them from the engine they configure rather than from a second module.
 */
export type { McpTargetProbe, McpTargetProbeResult };

/** Constructor dependencies for {@link AgentMcpOAuthService}. */
export interface AgentMcpOAuthServiceDeps {
  /** The resolved DorkOS data directory (never `os.homedir()`; see `lib/dork-home.ts`). */
  dorkHome: string;
  /** Loopback base URL the browser can reach this server at, e.g. `http://127.0.0.1:4242`. */
  callbackBaseUrl: string;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn'>;
  /** `fetch` seam for the OAuth network calls (defaults to global `fetch`). */
  fetchImpl?: FetchFn;
  /**
   * Per-request ceiling for every OAuth HTTP call, in ms (defaults to
   * {@link OAUTH_REQUEST_TIMEOUT_MS}).
   *
   * A seam like {@link sleep} and {@link cache}, and for the same reason: the
   * ceiling is what stops a hung token endpoint from holding a target's lock
   * forever, and a bound nothing can exercise end-to-end is a bound nobody has
   * checked. Thirty real seconds is not a thing a test can wait for.
   */
  requestTimeoutMs?: number;
  /** Clock/timer seams forwarded to the access-token cache (tests only). */
  cache?: McpAccessTokenCacheDeps;
  /** Delay seam for the refresh backoff (tests only); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Reachability probe for a target (DOR-1003). Present, it makes a connected
   * sign-in report how many tools it unlocked, and it stops a stored-but-refused
   * token from being announced as "already connected". Omitted → the engine keeps
   * its pre-DOR-1003 behaviour and simply has no opinion on either.
   */
  probe?: McpTargetProbe;
  /**
   * Called when a sign-in that BEGAN INSIDE A SESSION connects (DOR-1004), so the
   * agent that asked for it can be brought back the moment the token lands.
   *
   * A port, not a direct call, because this engine has no business knowing what
   * a session is — and because fire-once then costs nothing to guarantee: the
   * flow reaches `connected` exactly once, under this target's own lock, so the
   * port is called exactly once too. Absent → nothing is resumed, which is the
   * right behaviour for every sessionless start and for tests that only care
   * about the token exchange.
   */
  onSigninConnected?: McpSigninConnectedPort;
}

/** The result `mcp.signin` needs: a sign-in link, or a note that the server is already connected. */
export interface StartSigninResult {
  /** The flow id the client polls with. */
  flowId: string;
  /** The sign-in link to open, absent when {@link alreadyConnected}. */
  authorizeUrl?: string;
  /** True when a live token already existed AND the server accepted it, so no browser step is needed. */
  alreadyConnected: boolean;
}

/** The result `mcp.poll_signin` needs: the flow's status, plus the payoff once it connects. */
export interface PollSigninResult {
  /** Whether the sign-in is still waiting, finished, or failed. */
  status: McpSigninStatus;
  /** The failure reason, when the status is `failed`. */
  error?: string;
  /**
   * How many tools the server exposes, present only once the sign-in connected
   * AND the server answered a probe. Absent is not "zero" — it is "not counted",
   * which is why counting never gates reporting the connection.
   */
  toolCount?: number;
}

/**
 * The per-target lock key: `(agentId, serverName)` joined by NUL, which neither
 * part can contain. Every operation that reads-then-writes one server's token
 * store serializes on this.
 */
function lockKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`;
}

/** {@link lockKey} for a whole target. */
function targetKey(target: McpOAuthTarget): string {
  return lockKey(target.agentId, target.serverName);
}

/**
 * The managed-MCP OAuth engine. One instance per server process; construct after
 * `dorkHome` resolves and the listen port is known.
 */
export class AgentMcpOAuthService {
  private readonly secrets: McpOAuthSecretStore;
  private readonly flows = new McpOAuthFlowStore();
  private readonly cache: McpAccessTokenCache;
  private readonly refresher: McpTokenRefresher;
  private readonly redirectUri: string;
  private readonly fetchImpl: FetchFn;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly probe: McpTargetProbe | undefined;

  private readonly onSigninConnected: McpSigninConnectedPort | undefined;

  constructor(deps: AgentMcpOAuthServiceDeps) {
    this.probe = deps.probe;
    this.onSigninConnected = deps.onSigninConnected;
    this.secrets = new McpOAuthSecretStore(
      new ExtensionSecretStore(MCP_OAUTH_STORE_ID, deps.dorkHome)
    );
    this.cache = new McpAccessTokenCache(deps.cache ?? {});
    this.logger = deps.logger ?? console;
    this.refresher = new McpTokenRefresher({
      logger: this.logger,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    this.redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, deps.callbackBaseUrl).toString();
    // Bounded at the seam, so every OAuth request — sign-in, callback exchange,
    // background refresh — inherits the ceiling that keeps a hung token endpoint
    // from wedging a target's lock.
    this.fetchImpl =
      deps.requestTimeoutMs === undefined
        ? withRequestTimeout(deps.fetchImpl ?? fetch)
        : withRequestTimeout(deps.fetchImpl ?? fetch, deps.requestTimeoutMs);
  }

  /**
   * The live access token for `(agentId, serverName)` at `serverUrl`, or
   * `undefined`. Synchronous — this is the exact call the injection read path
   * makes to decide whether to merge the bearer header. A token minted for a
   * different URL is never handed out (DOR-986).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   * @param serverUrl - The URL the caller is about to send the token to.
   */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined {
    return this.cache.getAccessToken(agentId, serverName, serverUrl);
  }

  /**
   * Begin a sign-in for a target: mint a flow, drive the SDK `auth()` orchestrator
   * (discovery → DCR → PKCE authorize URL), and return the link for the operator
   * to open. When a live token already exists AND the server still accepts it,
   * this reports `alreadyConnected` with no link. A failure drops the flow it
   * minted rather than parking it as `pending`: no link ever reached the operator,
   * so nothing can legitimately poll it, and a claimable `state` is one a stray
   * callback could still redeem.
   *
   * Serialized against the background refresh for the same target, so the two can
   * never present the same refresh token to a rotating issuer at once.
   *
   * @param target - The agent, server, and server URL to authorize.
   * @param options - The session that asked for this sign-in, when one did
   *   (DOR-1004), and the directory it runs in (DOR-981) — both recorded on the
   *   flow so the resume can find them after a restart.
   * @throws {McpSigninStartError} When the sign-in cannot be started at all,
   *   carrying the plain family a person reads and the raw detail behind it
   *   (DOR-982).
   */
  async startSignin(
    target: McpOAuthTarget,
    options?: { originSessionId?: string; originCwd?: string }
  ): Promise<StartSigninResult> {
    return this.refresher.exclusive(targetKey(target), async () => {
      const state = randomBytes(16).toString('hex');
      this.flows.start(state, {
        ...target,
        ...(options?.originSessionId ? { originSessionId: options.originSessionId } : {}),
        ...(options?.originCwd ? { originCwd: options.originCwd } : {}),
      });
      // The provider writes its progress here as `auth()` walks it, so a throw
      // can be classified by the STAGE it died at rather than by its wording.
      const progress = newSigninProgress();
      try {
        const connected = await this.authorize(target, state, progress);
        if (connected) return connected;

        const authorizeUrl = this.flows.authorizeUrl(state);
        if (!authorizeUrl) throw new Error('Could not build a sign-in link for this server.');
        return { flowId: state, authorizeUrl, alreadyConnected: false };
      } catch (err) {
        // No link ever reached the operator, so this flow can never be polled —
        // and a `state` left claimable is a `state` a stray callback could still
        // redeem. Drop it rather than leaving it parked as `pending` for its TTL.
        this.flows.drop(state);
        const failure = classifySigninFailure(err, progress);
        this.logger.warn(
          `[mcp-oauth] sign-in could not start for ${target.serverName} (${failure.code}): ${failure.detail}`
        );
        throw new McpSigninStartError(failure, err);
      }
    });
  }

  /**
   * Store app credentials an operator got from a provider that will not let
   * DorkOS register itself (DOR-982), so the next {@link startSignin} signs in as
   * that app instead of trying to register a new one.
   *
   * Nothing else changes: the SDK's `auth()` skips registration entirely once a
   * client identity is stored, so this is the whole of the fallback.
   *
   * **Saving replaces the identity, so it forgets the sign-in.** A token issued
   * to the old client is not honoured for the new one, and a stored registration
   * from a failed automatic attempt would shadow what the operator just typed.
   * Both go, through the same seam a removal uses — under this target's lock, so
   * a refresh already on the wire cannot land afterwards and resurrect either.
   *
   * The credential itself is never logged, never returned, and never reaches the
   * manifest; it lives beside the token set in the encrypted store.
   *
   * @param target - The agent, server, and server URL the credentials are for.
   * @param credentials - The client id, and the client secret when there is one.
   */
  async saveManualClientInfo(
    target: McpOAuthTarget,
    credentials: McpClientCredentials
  ): Promise<void> {
    await this.refresher.exclusive(targetKey(target), async () => {
      await this.forgetServerUnlocked(target.agentId, target.serverName);
      await this.secrets.saveClientInformation(
        target.agentId,
        target.serverName,
        {
          client_id: credentials.clientId,
          ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
          // The SDK needs the metadata half of the record to be well-formed even
          // though the provider already knows this app's redirect URI: it is the
          // same loopback callback every DorkOS sign-in uses.
          redirect_uris: [this.redirectUri],
        },
        'manual'
      );
      // Any link already on screen for this server authorizes the OLD client, so
      // it would fail at the provider. Retiring those flows makes the operator's
      // next "Try again" the only live one — and doing it under the lock keeps a
      // callback that is mid-exchange from redeeming one on the way past.
      this.flows.dropFor(target.agentId, target.serverName);
    });
  }

  /**
   * Where the stored OAuth client identity for a server came from, or
   * `undefined` when DorkOS holds none (DOR-982). Names the identity; never
   * exposes it.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  clientOrigin(agentId: string, serverName: string): Promise<McpClientOrigin | undefined> {
    return this.secrets.clientOrigin(agentId, serverName);
  }

  /**
   * Drive `auth()` for a flow and, when it reports the target is already
   * authorized, **prove it before saying so** (DOR-1003).
   *
   * `auth()` answering `AUTHORIZED` only means DorkOS found a token set it could
   * load or silently refresh. It does not mean the server still honours it —
   * a revoked grant, a rotated client, or a server that has forgotten the session
   * all look identical from here. Reporting `alreadyConnected` on that evidence
   * told the operator they were connected and then failed on the next turn, with
   * no sign-in link anywhere to fix it. So the token is dialled once: if the
   * server refuses it, the stored credential is dropped (the DOR-986
   * invalidation seam) and the loop asks for a real sign-in instead.
   *
   * With no probe wired the proof step is skipped and `AUTHORIZED` is taken at
   * face value, exactly as before.
   *
   * @param target - The agent, server, and server URL to authorize.
   * @param state - The flow id this sign-in is registered under.
   * @param progress - Where the provider records how far `auth()` got, so the
   *   caller can classify a throw (DOR-982).
   * @returns The already-connected result, or `undefined` when a browser step is
   *   needed — by which point the authorize URL is captured on the flow.
   */
  private async authorize(
    target: McpOAuthTarget,
    state: string,
    progress: McpSigninProgress
  ): Promise<StartSigninResult | undefined> {
    // Every OAuth request for this attempt goes through here, so "did anything
    // answer at all" is known without asking the provider — which never sees the
    // network, only what the SDK made of it.
    const observedFetch: FetchFn = async (...args) => {
      const response = await this.fetchImpl(...args);
      progress.responded = true;
      return response;
    };
    // At most two rounds: the first may find a stored token, the second is the
    // fresh sign-in that replaces it once the first is shown to be dead.
    for (let round = 0; round < 2; round++) {
      const result = await auth(this.providerFor(target, state, progress), {
        serverUrl: target.serverUrl,
        fetchFn: observedFetch,
      });
      if (result !== 'AUTHORIZED') return undefined;
      await this.primeFromStore(target);
      if (!tokenWasRefused(await probeTarget(this.probe, target, this.logger))) {
        this.flows.markConnected(state);
        return { flowId: state, alreadyConnected: true };
      }
      // Held under this target's lock already, so the unlocked body is the right
      // one — taking the lock again would wait on ourselves.
      await this.forgetServerUnlocked(target.agentId, target.serverName);
    }
    return undefined;
  }

  /**
   * The pollable status of a sign-in flow (`pending` | `connected` | `failed`),
   * carrying the payoff once it connects: how many tools the operator just
   * unlocked (DOR-1003).
   *
   * The count is a bonus, never a gate. A server that connected but would not
   * answer the follow-up probe still reports `connected` with the count absent —
   * the sign-in succeeded, and saying otherwise because a second round trip
   * failed would be a lie in the more damaging direction.
   *
   * @param flowId - The flow id from {@link startSignin}.
   */
  async pollSignin(flowId: string): Promise<PollSigninResult> {
    const status = this.flows.status(flowId);
    if (status.status !== 'connected') return status;
    const target = this.flows.target(flowId);
    if (!target) return status;
    const toolCount = toolCountFrom(await probeTarget(this.probe, target, this.logger));
    return toolCount === undefined ? status : { ...status, toolCount };
  }

  /**
   * The sign-in link already waiting for a target, or `undefined` (DOR-981).
   *
   * Exists so a caller reacting to a REFUSED token can re-use a live flow
   * instead of minting a second one. A server that 401s once in a turn usually
   * 401s several times, and one card per refusal would stack dead links above
   * the working one.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  liveSigninFor(
    agentId: string,
    serverName: string
  ): { flowId: string; authorizeUrl: string } | undefined {
    const flow = this.flows.liveFor(agentId, serverName);
    return flow ? { flowId: flow.flowId, authorizeUrl: flow.authorizeUrl } : undefined;
  }

  /**
   * Handle the loopback callback: exchange the authorization code for tokens (via
   * the SDK `auth()` code path), prime the cache, and mark the flow connected.
   * Never throws — returns a status for the browser page.
   *
   * Reloading the callback page is treated as success, not failure: the PKCE
   * verifier is one-shot, so a second exchange always fails, and letting that
   * failure overwrite an already-`connected` flow told the operator their
   * successful sign-in had failed (DOR-986).
   *
   * A failed exchange can still leave the dynamic client registration on disk —
   * it is written before the code is exchanged. No token is stored, which is what
   * decides whether the server is usable.
   *
   * Serialized against the background refresh for the same target, so a refresh
   * that started on the OLD refresh token cannot land after this exchange and
   * overwrite the grant the operator just approved.
   *
   * The server's name comes back with the result so the landing page can say
   * WHICH server the operator just signed in to (DOR-1003) — it is known here and
   * nowhere else, since the browser only ever carried the opaque `state`.
   *
   * @param args - The `state`, `code`, and optional `error` from the callback query.
   */
  async handleCallback(args: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ connected: boolean; error?: string; serverName?: string }> {
    const { state, code, error } = args;
    if (!state) return { connected: false, error: 'Missing sign-in state. Please start again.' };
    const target = this.flows.target(state);
    if (!target)
      return { connected: false, error: 'This sign-in link expired. Please start again.' };
    const serverName = target.serverName;
    if (this.flows.status(state).status === 'connected') return { connected: true, serverName };
    if (error || !code) {
      const message = 'Sign-in was cancelled.';
      this.flows.markFailed(state, message);
      return { connected: false, error: message, serverName };
    }

    return this.refresher.exclusive(targetKey(target), async () => {
      // Re-checked INSIDE the lock, and the check above is only a fast path. Two
      // callbacks can both pass an unlocked check while the first exchange is
      // still on the wire — a browser reload during those hundreds of
      // milliseconds is exactly how this happens. The second would then run the
      // exchange against a spent one-shot verifier, throw, and `markFailed` over
      // a flow that is already connected (DOR-986).
      if (this.flows.status(state).status === 'connected') return { connected: true, serverName };
      try {
        const provider = this.providerFor(target, state);
        await auth(provider, {
          serverUrl: target.serverUrl,
          authorizationCode: code,
          fetchFn: this.fetchImpl,
        });
        // The exchange is only real if a token actually landed: `auth()` reports
        // success, but the cache is what injection reads, so that is what we check.
        if (!(await this.primeFromStore(target))) {
          const message = 'The server did not complete the sign-in. Please try again.';
          this.flows.markFailed(state, message);
          return { connected: false, error: message, serverName };
        }
        this.flows.markConnected(state);
        await this.announceConnected(state, target);
        return { connected: true, serverName };
      } catch (err) {
        // Keep the raw detail in the server log; hand the browser + poll a generic
        // message (the callback lands in the operator's own loopback browser, but
        // an exchange error can echo request context, so match the non-catch paths).
        this.logger.warn(
          `[mcp-oauth] callback failed for ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
        );
        const message = 'Sign-in failed. Please try again.';
        this.flows.markFailed(state, message);
        return { connected: false, error: message, serverName };
      }
    });
  }

  /**
   * Tell the session that asked for this sign-in that it landed (DOR-1004).
   *
   * Runs INSIDE the target's lock, immediately after the flow transitions to
   * `connected` — which happens exactly once per flow, so this fires exactly
   * once too, with no de-duplication to get wrong. A sessionless start recorded
   * no session and is skipped: the settings panel, the external `/mcp` server and
   * HTTP have no conversation to bring back.
   *
   * The tool count is gathered here, from the same probe `pollSignin` uses, so
   * the resumed agent's payload can say what the person actually unlocked. It is
   * a bonus and never a gate: a probe that fails leaves the count absent and the
   * resume goes ahead, because the sign-in DID succeed and withholding the resume
   * over a second round trip would be the more damaging lie.
   *
   * Never allowed to throw. The caller is a loopback callback the person's
   * browser is waiting on, and their "you can close this tab" page must not turn
   * into an error because a turn could not be started.
   */
  private async announceConnected(state: string, target: McpOAuthTarget): Promise<void> {
    const port = this.onSigninConnected;
    if (!port) return;
    const flow = this.flows.target(state);
    if (!flow?.originSessionId) return;
    try {
      const toolCount = toolCountFrom(await probeTarget(this.probe, target, this.logger));
      port({
        agentId: target.agentId,
        serverName: target.serverName,
        sessionId: flow.originSessionId,
        flowId: state,
        // Captured when the sign-in started, so the resume knows WHERE to run
        // even after a restart has taken the session's projector with it
        // (DOR-981). Absent for a flow started before this existed.
        ...(flow.originCwd ? { originCwd: flow.originCwd } : {}),
        ...(toolCount === undefined ? {} : { toolCount }),
      });
    } catch (err) {
      this.logger.warn(
        `[mcp-oauth] could not announce the sign-in for ${target.serverName}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Re-prime the cache from disk for a set of targets after a restart, scheduling
   * each token's background refresh. A target with no stored token is skipped
   * (stays needs-auth until the operator signs in).
   *
   * Runs under each target's own lock, like every other caller of
   * {@link primeFromStore}. Boot is quiet enough that nothing can be racing yet,
   * so the lock buys no safety today — it buys the INVARIANT: "every caller of
   * `primeFromStore` holds this target's lock" is now true by construction rather
   * than by an argument about when boot happens, which is what
   * {@link forgetServerUnlocked} depends on and what a later caller of `warm`
   * would otherwise quietly break (DOR-986 re-review). Deadlock-free because
   * `warm`'s callers hold no lock: boot calls it, and so does the test suite.
   *
   * @param targets - The enabled OAuth-capable managed servers across all agents.
   */
  async warm(targets: McpOAuthTarget[]): Promise<void> {
    for (const target of targets) {
      await this.refresher
        .exclusive(targetKey(target), () => this.primeFromStore(target))
        .catch((err: unknown) => {
          this.logger.warn(
            `[mcp-oauth] warm failed for ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }
  }

  /**
   * Forget one server's OAuth credentials: delete the stored token set and client
   * registration, and drop the cached token along with its refresh timer. Called
   * when a managed server is removed, and when its URL changes — the token was
   * minted for a specific server, so it must not survive being re-pointed at a
   * different one.
   *
   * Serialized on the target's own lock, like every other writer of its token
   * store. Without that, a refresh already on the wire finishes after the delete
   * and writes a brand-new access + refresh token back to disk for a server the
   * operator just removed — cache clean, disk dirty, and nothing ever sweeps it
   * (DOR-986).
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  async forgetServer(agentId: string, serverName: string): Promise<void> {
    await this.refresher.exclusive(lockKey(agentId, serverName), () =>
      this.forgetServerUnlocked(agentId, serverName)
    );
  }

  /**
   * The body of {@link forgetServer} without taking the lock. ONLY for callers
   * that already hold it — taking it again from inside would wait on the
   * operation currently holding it, which never completes.
   *
   * That precondition used to be a comment on each call site. It is now
   * structural: every path that reaches here goes through
   * {@link primeFromStore} or {@link authorize}, and every caller of THOSE runs
   * inside `refresher.exclusive` for this target ({@link startSignin},
   * {@link handleCallback}, {@link warm}). Adding a caller that does not is the
   * one way to reintroduce the hazard, and the lock it must take is now the same
   * lock every sibling takes rather than a special case for boot.
   */
  private async forgetServerUnlocked(agentId: string, serverName: string): Promise<void> {
    this.cache.evict(agentId, serverName);
    await this.secrets.clear(agentId, serverName);
  }

  /**
   * Forget every OAuth credential belonging to one agent — the deleted-agent
   * cascade, so an agent's tokens do not outlive the agent.
   *
   * The agent's manifest is already gone by the time it is unregistered, so the
   * servers it used to have are recovered from the store's own key namespace —
   * and each one is then forgotten under its own lock, for the same reason
   * {@link forgetServer} takes one.
   *
   * @param agentId - The agent being deleted.
   */
  async forgetAgent(agentId: string): Promise<void> {
    this.cache.evictAgent(agentId);
    const serverNames = await this.secrets.serverNames(agentId);
    await Promise.all(serverNames.map((name) => this.forgetServer(agentId, name)));
  }

  /**
   * Run a target's background refresh right now, exactly as its scheduled timer
   * would, and report whether a fresh token replaced the cached one.
   *
   * @param target - The agent, server, and server URL to refresh.
   * @internal Exercised by tests; production reaches this through the cache timer.
   */
  async refreshNow(target: McpOAuthTarget): Promise<boolean> {
    return this.cache.refreshNow(target.agentId, target.serverName);
  }

  /**
   * The same refresh, reporting WHY it ended rather than just whether it worked.
   *
   * The distinction is what stops a flapping network from deleting a good grant:
   * only `terminal` is the OAuth server's own refusal (DOR-981). See
   * {@link McpAccessTokenCache.refreshVerdict}.
   *
   * @param target - The agent, server, and server URL to refresh.
   */
  async refreshVerdict(target: McpOAuthTarget): Promise<McpCacheRefreshVerdict> {
    return this.cache.refreshVerdict(target.agentId, target.serverName);
  }

  /** Cancel every pending refresh and empty the token cache (shutdown). */
  shutdown(): void {
    this.cache.clear();
  }

  /**
   * Load the stored token set for a target and prime the cache. Returns whether a
   * token was primed. A stored set bound to a different URL than the target's is
   * deleted rather than primed: it authorizes a server this name no longer points
   * at, so it can only ever be sent to the wrong place.
   *
   * Deletes through the UNLOCKED path deliberately: every caller — sign-in, the
   * callback, `warm` — already holds this target's lock, so taking it here would
   * be a self-deadlock.
   */
  private async primeFromStore(target: McpOAuthTarget): Promise<boolean> {
    const tokens = await this.secrets.tokens(target.agentId, target.serverName);
    if (!tokens) return false;
    if (tokens.serverUrl !== target.serverUrl) {
      this.logger.warn(
        `[mcp-oauth] dropping the stored token for ${target.serverName}: it was issued for a different URL`
      );
      await this.forgetServerUnlocked(target.agentId, target.serverName);
      return false;
    }
    this.primeCache(target, tokens);
    return true;
  }

  /** Cache a stored token set (by its ABSOLUTE expiry) and bind its background refresh. */
  private primeCache(target: McpOAuthTarget, tokens: StoredMcpTokens): void {
    this.cache.store(target.agentId, target.serverName, toCachedToken(tokens), () =>
      this.refresher.refresh(targetKey(target), () =>
        attemptTokenRefresh({
          // A state no flow owns: every flow-store write this provider makes is a
          // no-op, so a background refresh can never clobber a live sign-in.
          provider: this.providerFor(target, `refresh:${randomBytes(8).toString('hex')}`),
          serverUrl: target.serverUrl,
          fetchImpl: this.fetchImpl,
          loadTokens: () => this.secrets.tokens(target.agentId, target.serverName),
        })
      )
    );
  }

  /**
   * Build a provider bound to one target + sign-in state.
   *
   * @param target - The agent, server, and server URL being authorized.
   * @param state - The flow id, and the flow-store key for the transient half.
   * @param progress - Where to record how far `auth()` got. Omitted by the
   *   background refresh, which has no operator to classify a failure for.
   */
  private providerFor(
    target: McpOAuthTarget,
    state: string,
    progress?: McpSigninProgress
  ): McpOAuthClientProvider {
    const ctx: McpOAuthProviderContext = {
      agentId: target.agentId,
      serverName: target.serverName,
      serverUrl: target.serverUrl,
      state,
      redirectUri: this.redirectUri,
      secrets: this.secrets,
      flows: this.flows,
      ...(progress ? { progress } : {}),
    };
    return new McpOAuthClientProvider(ctx);
  }
}

/**
 * The custody disclosure shown before a managed-MCP sign-in and returned verbatim
 * by `mcp.signin` — the plain-language statement of WHERE the token lives, the
 * same honesty control the connector flow carries. Unlike Composio's managed
 * custody, the token never leaves the machine.
 *
 * @param serverName - The server being signed into, named in the sentence.
 */
export function mcpOAuthCustodyDisclosure(serverName: string): string {
  return (
    `Signing in takes you to ${serverName} to approve access. ` +
    'DorkOS keeps the resulting token encrypted on this computer and sends it to the ' +
    'server on your behalf. Your password is never shared, and you can remove the server anytime.'
  );
}
