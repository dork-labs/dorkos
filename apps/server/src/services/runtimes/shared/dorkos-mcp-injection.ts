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

/**
 * The name the injected server is registered under, on both runtimes.
 *
 * It matches the in-session server's name on claude-code deliberately: an agent
 * that moves between runtimes should not have to learn a second spelling of the
 * same tool. Both adapters reserve it so a user's own server of this name cannot
 * shadow it.
 */
export const DORKOS_MCP_SERVER_NAME = 'dorkos';

/**
 * What Codex puts in front of a `dorkos` MCP tool name.
 *
 * Codex qualifies plugin-provided MCP tools as `mcp__server__tool` — stated in
 * its own system prompt, and already the convention `event-mapper.ts` reproduces
 * when it maps an `mcp_tool_call` into a StreamEvent.
 *
 * Assembled from {@link DORKOS_MCP_SERVER_NAME} rather than written out, so
 * renaming the server moves the prompt with it and cannot leave the two
 * disagreeing.
 */
export const CODEX_DORKOS_TOOL_PREFIX = `mcp__${DORKOS_MCP_SERVER_NAME}__`;

/**
 * What OpenCode puts in front of a `dorkos` MCP tool name.
 *
 * OpenCode composes `sanitize(server) + "_" + sanitize(tool)` and hands that key
 * straight to the model as the callable function name — one underscore, and no
 * `mcp` marker at all. Neither `dorkos` nor any DorkOS tool name contains a
 * character its sanitizer rewrites, so the result is exactly this concatenation.
 */
export const OPENCODE_DORKOS_TOOL_PREFIX = `${DORKOS_MCP_SERVER_NAME}_`;

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
 * Whether this session is going to carry the DorkOS tools — the same question
 * {@link resolveDorkosMcpInjection} answers, minus the mint.
 *
 * It exists because the PROMPT has to be gated on the same fact as the wiring,
 * and the prompt is assembled at a point where minting a second token would be
 * pure waste (tokens accumulate per mint; nothing collects the spare).
 *
 * The one thing it cannot see is a mint FAILURE, which is the only way the two
 * answers diverge: the block would then name tools that turned out not to be
 * there, costing an agent one turn to discover it. That failure already logs a
 * warning, it is rare, and the alternative — minting twice per turn to keep a
 * paragraph honest — is worse. Anything that must be exact about tool presence
 * (reply mode, in the flip that follows this wiring) reads the injection result
 * itself, never this.
 *
 * @param agentPath - The session's working directory, when it hosts a registered
 *   agent. `undefined` answers `false`.
 */
export function dorkosToolsEnabledFor(agentPath: string | undefined): boolean {
  if (agentPath === undefined) return false;
  if (configManager?.get('runtimes')?.dorkosTools !== true) return false;
  if (configManager?.get('mcp')?.enabled !== true) return false;
  return resolveMcpBearer() !== null;
}

/**
 * Resolve the `dorkos` MCP entry for one agent-bound session, or `null` when it
 * must not be injected.
 *
 * Five ways this withholds, each of them a state a person can actually be in:
 *
 * 1. `runtimes.dorkosTools` is off — the default, and the whole point of the
 *    flag.
 * 2. `mcp.enabled` is off — `/mcp` answers a clean 503 (`requireMcpEnabled`), so
 *    the entry would be a server that never connects.
 * 3. This working directory hosts no registered agent — there is no identity to
 *    present, and these tools act as somebody.
 * 4. No bearer exists (see {@link resolveMcpBearer}).
 * 5. Minting the identity token failed.
 *
 * Every one of them logs, because a person who turned the experiment on and sees
 * no new tools needs to be able to find out why. Failures 4 and 5 warn; the
 * rest are ordinary configuration and stay at debug.
 *
 * @param agentPath - The session's working directory, when it hosts a registered
 *   agent. `undefined` withholds (case 3).
 * @param displayName - The agent's human-readable name. Minted onto the token's
 *   label, which every room tool replays onto the agent's author row — so this
 *   must be the name a PERSON reads, never the slug (DOR-1264).
 * @returns The entry to inject, or `null` to inject nothing.
 */
export async function resolveDorkosMcpInjection(
  agentPath: string | undefined,
  displayName: string | undefined
): Promise<DorkosMcpInjection | null> {
  // Both hops are optional-chained on purpose. `configManager` is a `let`
  // binding that `initConfigManager` assigns at boot, so it is genuinely
  // `undefined` before that — and the section under it can be absent on a
  // partially configured store (`mcp-auth.ts` reads `mcp` the same way). An
  // experiment that THROWS when read would take the turn down with it, which is
  // a far worse failure than the experiment staying off.
  if (configManager?.get('runtimes')?.dorkosTools !== true) return null;

  if (agentPath === undefined) return null;

  if (configManager?.get('mcp')?.enabled !== true) {
    logger.debug(
      '[dorkos-mcp] not injecting the DorkOS tools — the MCP endpoint is off (config `mcp.enabled`)',
      { agentPath }
    );
    return null;
  }

  const bearer = resolveMcpBearer();
  if (!bearer) {
    logger.warn(
      '[dorkos-mcp] not injecting the DorkOS tools — this instance has no MCP bearer to present. ' +
        'Login is on and no MCP_API_KEY is set, so /mcp would refuse every call.',
      { agentPath }
    );
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

  return {
    url: dorkosMcpUrl(),
    headers: {
      Authorization: `Bearer ${bearer}`,
      [AGENT_IDENTITY_HEADER]: agentToken,
    },
  };
}
