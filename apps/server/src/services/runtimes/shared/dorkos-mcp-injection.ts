/**
 * The `dorkos` MCP server DorkOS injects into Codex and OpenCode sessions, so
 * agents on those runtimes reach the same DorkOS tools a claude-code agent
 * already carries in-process (spec `tool-only-room-replies` §D4; DOR-1613).
 *
 * Claude Code needs none of this: its `dorkos` server runs INSIDE the session,
 * so identity is structural (`createInSessionContextResolver`) and no credential
 * crosses a wire. The other two runtimes are separate programs, so they reach
 * DorkOS the way any outside client does — over this server's own `/mcp`,
 * streamable HTTP, holding two headers. This module owns that one entry, for
 * both runtimes, so there is a single place where the URL, the credentials and
 * the refusals are decided.
 *
 * ## Why both headers are mandatory, and why absence withholds
 *
 * - `Authorization` — rooms tools carry no `readOnlyCarveOut` (`tool-security.ts`),
 *   deliberately, because what they return is other people's messages. Without a
 *   bearer every room write is a 401.
 * - `X-DorkOS-Agent` — without it `callerAuthor` falls through to the INSTALL
 *   OWNER, and the agent would post in the operator's name. That is
 *   impersonation, not a degraded experience.
 *
 * So this resolver returns `null` — injecting nothing — rather than ever
 * emitting a half-credentialed entry. A runtime with no `dorkos` server behaves
 * exactly as it does today, which is the safe default; a runtime holding a
 * server it cannot authenticate against would fail on every call, loudly and
 * repeatedly, in front of the person.
 *
 * ## The token is minted per resolve, never cached
 *
 * Agent tokens expire on a 7-day-idle / 30-day-absolute fuse
 * (`agent-identity-service.ts`), and a stored hash cannot be reversed to reissue
 * an existing secret. Codex resolves this per turn and OpenCode per reconcile,
 * so neither fuse can arm on a long-lived session. Previously minted tokens stay
 * valid, so re-minting never invalidates a concurrent session for the same
 * agent.
 *
 * @module services/runtimes/shared/dorkos-mcp-injection
 */
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';
import { localDialHost } from '../../../lib/local-dial-host.js';
import { configManager } from '../../core/config-manager.js';
import { getMcpLocalToken } from '../../core/auth/mcp-local-token.js';
import { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from '../../core/agent-identity/index.js';
import { AGENT_IDENTITY_HEADER } from '../../../middleware/agent-identity.js';
import { DORKOS_MCP_SERVER_NAME } from './dorkos-tool-names.js';

export { DORKOS_MCP_SERVER_NAME };

/**
 * The environment variables Codex reads the two header VALUES out of.
 *
 * Codex flattens `CodexOptions.config` into `--config key=value` arguments on
 * the `codex exec` command line, so a header value written into `http_headers`
 * is an argv entry — readable by any process running as this user, via `ps`.
 * Both of these values are credentials (one is the MCP bearer, the other is an
 * agent identity that can post as that agent), so neither may go there.
 *
 * Codex's `env_http_headers` takes header name → env var NAME and resolves the
 * value inside the subprocess, so the config carries only these variable names
 * and the secrets ride the environment — the same channel `DORKOS_AGENT_TOKEN`
 * already uses.
 *
 * The names are prefixed and explicit rather than short, because they are
 * spread into an inherited environment: a collision would silently replace a
 * credential with somebody else's value.
 */
export const DORKOS_MCP_HEADER_ENV_VARS: Readonly<Record<string, string>> = {
  Authorization: 'DORKOS_MCP_HEADER_AUTHORIZATION',
  [AGENT_IDENTITY_HEADER]: 'DORKOS_MCP_HEADER_AGENT_TOKEN',
};

/** One injected `dorkos` server: where to reach it, and what to present. */
export interface DorkosMcpInjection {
  /** Streamable-HTTP endpoint — this server's own `/mcp`. */
  url: string;
  /** `Authorization` plus `X-DorkOS-Agent`; never partial (see the module doc). */
  headers: Record<string, string>;
}

/**
 * The URL a local runtime dials to reach this server's `/mcp`.
 *
 * Minted through {@link localDialHost}, never a hardcoded `127.0.0.1` (DOR-723).
 * The server BINDS `env.DORKOS_HOST`, which Node resolves to one address family:
 * on a host where `localhost` is `::1`, a `127.0.0.1` URL is connection-refused,
 * and the shipped Docker image binds the wildcard `0.0.0.0`, which Windows
 * refuses to dial at all. `localDialHost` maps wildcards to `localhost` and
 * brackets IPv6 literals so the result is always a parseable URL.
 */
export function dorkosMcpUrl(): string {
  return `http://${localDialHost(env.DORKOS_HOST)}:${env.DORKOS_PORT}/mcp`;
}

/**
 * The bearer a local runtime presents to `/mcp`, or `null` when this instance
 * has none it could use.
 *
 * The two acceptors are mutually exclusive by construction, and the order says
 * so honestly rather than relying on it: `getMcpLocalToken()` returns `null`
 * whenever `MCP_API_KEY` is set (that env override IS the bearer then), and
 * again whenever login is on, because the local token is inactive in that
 * posture (ADR-0320).
 *
 * `null` is therefore a real, reachable state — login ON with no `MCP_API_KEY`
 * — and in it there is no tokenless path on this surface at all, not even tool
 * discovery. Injecting a server every call would 401 against is worse than
 * injecting none, so the caller withholds.
 */
function resolveMcpBearer(): string | null {
  const envKey = env.MCP_API_KEY?.trim();
  if (envKey) return envKey;
  return getMcpLocalToken();
}

/**
 * Whether this instance would inject the `dorkos` server for a directory, and
 * when it would not, which of the four configuration answers says so.
 *
 * Everything except the mint, which is the one precondition that cannot be
 * answered without doing it (see {@link dorkosToolsPosture}).
 */
export type DorkosToolsPosture =
  { wired: true } | { wired: false; why: 'experiment-off' | 'no-agent' | 'mcp-off' | 'no-bearer' };

/**
 * Ask whether this instance is configured to hand a directory's sessions the
 * DorkOS tools.
 *
 * **One decision site, two consumers.** {@link resolveDorkosMcpInjection} builds
 * the entry from it, and a room asks it — through
 * `AgentRuntime.carriesRoomTools` — before deciding whether a turn's own text is
 * posted. Two copies of these four conditions is how a room comes to suppress a
 * turn's words for a session that never got the tool, which is the mute state
 * this whole design is arranged around.
 *
 * Four answers, each a state a person can actually be in:
 *
 * 1. `experiment-off` — `runtimes.dorkosTools` is off, the default.
 * 2. `no-agent` — this working directory hosts no registered agent. There is no
 *    identity to present, and these tools act as somebody.
 * 3. `mcp-off` — `mcp.enabled` is off, so `/mcp` answers a clean 503
 *    (`requireMcpEnabled`) and the entry would be a server that never connects.
 * 4. `no-bearer` — see {@link resolveMcpBearer}.
 *
 * **The fifth withhold is not here, and cannot be**: minting the identity token
 * can fail, and finding that out means minting one. A caller that only wants to
 * KNOW (rather than to inject) would pay a write per turn to close a gap whose
 * one reachable cause is a database error that the next turn clears. So a room
 * reading `wired: true` is reading "configured to carry them", which is the most
 * that can be known before the turn starts.
 *
 * Both config hops are optional-chained on purpose. `configManager` is a `let`
 * binding that `initConfigManager` assigns at boot, so it is genuinely
 * `undefined` before that — and the section under it can be absent on a
 * partially configured store (`mcp-auth.ts` reads `mcp` the same way). An
 * experiment that THROWS when read would take the turn down with it, which is a
 * far worse failure than the experiment staying off.
 *
 * @param agentPath - The session's working directory, when it hosts a registered
 *   agent. `undefined` is `no-agent`.
 * @returns Whether the entry would be built, and why not when it would not.
 */
export function dorkosToolsPosture(agentPath: string | undefined): DorkosToolsPosture {
  if (configManager?.get('runtimes')?.dorkosTools !== true) {
    return { wired: false, why: 'experiment-off' };
  }
  if (agentPath === undefined) return { wired: false, why: 'no-agent' };
  if (configManager?.get('mcp')?.enabled !== true) return { wired: false, why: 'mcp-off' };
  if (!resolveMcpBearer()) return { wired: false, why: 'no-bearer' };
  return { wired: true };
}

/**
 * Resolve the `dorkos` MCP entry for one agent-bound session, or `null` when it
 * must not be injected.
 *
 * Five ways this withholds: the four {@link dorkosToolsPosture} decides, plus a
 * failed mint, which is the one that can only be found out by trying.
 *
 * Every one of them logs, because a person who turned the experiment on and sees
 * no new tools needs to be able to find out why. A missing bearer and a failed
 * mint warn; the rest are ordinary configuration and stay at debug.
 *
 * @param agentPath - The session's working directory, when it hosts a registered
 *   agent. `undefined` withholds.
 * @param displayName - The agent's human-readable name. Minted onto the token's
 *   label, which every room tool replays onto the agent's author row — so this
 *   must be the name a PERSON reads, never the slug (DOR-1264).
 * @returns The entry to inject, or `null` to inject nothing.
 */
export async function resolveDorkosMcpInjection(
  agentPath: string | undefined,
  displayName: string | undefined
): Promise<DorkosMcpInjection | null> {
  const posture = dorkosToolsPosture(agentPath);
  if (!posture.wired) {
    if (posture.why === 'mcp-off') {
      logger.debug(
        '[dorkos-mcp] not injecting the DorkOS tools — the MCP endpoint is off (config `mcp.enabled`)',
        { agentPath }
      );
    } else if (posture.why === 'no-bearer') {
      logger.warn(
        '[dorkos-mcp] not injecting the DorkOS tools — this instance has no MCP bearer to present. ' +
          'Login is on and no MCP_API_KEY is set, so /mcp would refuse every call.',
        { agentPath }
      );
    }
    return null;
  }

  // One mint path for the whole server: the same resolver the claude-code and
  // codex spawn seams call, so a change to how identity is issued cannot reach
  // one caller and miss another. It returns `{}` on every failure and never
  // throws, so an absent key here IS the failure signal.
  const tokenEnv = await resolveAgentTokenEnv(agentPath, displayName);
  const agentToken = tokenEnv[AGENT_TOKEN_ENV_VAR];
  if (agentToken === undefined) {
    logger.warn(
      '[dorkos-mcp] not injecting the DorkOS tools — could not mint an identity token for this agent. ' +
        "Injecting without one would post in the install owner's name.",
      { agentPath }
    );
    return null;
  }

  const bearer = resolveMcpBearer();
  // Re-read rather than carried out of the posture, and it cannot be `null`
  // here: `wired` is what proves one exists, and a config change between the two
  // reads is a window the next turn closes. Guarded anyway, because withholding
  // is what this module does when it cannot present both headers.
  if (!bearer) return null;

  return {
    url: dorkosMcpUrl(),
    headers: {
      Authorization: `Bearer ${bearer}`,
      [AGENT_IDENTITY_HEADER]: agentToken,
    },
  };
}
