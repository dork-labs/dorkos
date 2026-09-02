/**
 * The env seam where an agent's minted identity token enters a spawned session
 * (spec `agent-trust` §3.1).
 *
 * This mirrors `services/core/credential-env.ts` deliberately: a runtime calls
 * one resolver per spawn and spreads the returned fragment into the child env.
 * The token rides the PROCESS env rather than the context-builder's prompt
 * block, so it never enters the model's context or the session transcript — it
 * is a credential for the tools the agent runs (`dorkos call ...`), not
 * information for the model to read.
 *
 * Every failure path returns `{}`. A session that cannot be attributed must
 * still run exactly as it does today; identity is never required.
 *
 * @module services/core/agent-identity/agent-token-env
 */
import { readManifest } from '@dorkos/shared/manifest';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

import { logger } from '../../../lib/logger.js';
import { getAgentIdentityService, type AgentIdentityService } from './agent-identity-service.js';
import type { CapabilityInvocationContext } from '../capabilities/index.js';

/** The env var a spawned agent reads its identity token from. */
export const AGENT_TOKEN_ENV_VAR = 'DORKOS_AGENT_TOKEN';

/**
 * Mint a fresh identity token for the agent rooted at `agentPath` and return it
 * as a one-key env fragment for the spawn env.
 *
 * A new token is minted per spawn because a stored hash cannot be reversed to
 * re-issue an existing secret; previously minted tokens stay valid, so
 * concurrent sessions for the same agent never invalidate each other (see
 * `agent-identity-service.ts`).
 *
 * The agent's tier ceiling rides along, read from `.dork/agent.json` (DOR-486).
 * That file is the source of truth per ADR-0043 and the only place the answer
 * exists — the derived Mesh row has no column for it, deliberately, so nothing
 * can make this decision from a cache that cannot answer.
 *
 * Returns `{}` — leaving the session unattributed, exactly as today — when the
 * path hosts no registered agent, when the service was never initialized, or
 * when minting fails. Never throws, and never logs the token.
 *
 * @param agentPath - Absolute path to the agent's project directory, or
 *   `undefined` when the session's working directory hosts no registered agent.
 * @param displayName - Human-readable agent name for attribution labels.
 * @returns `{ DORKOS_AGENT_TOKEN }`, or `{}` when no identity applies.
 */
export async function resolveAgentTokenEnv(
  agentPath: string | undefined,
  displayName: string | undefined
): Promise<Record<string, string>> {
  if (!agentPath) return {};

  const service = getAgentIdentityService();
  if (!service) return {};

  try {
    const token = await service.mint({
      agentPath,
      displayName: displayName?.trim() || agentPath,
      ...(await resolveTierCeiling(agentPath, service)),
    });
    return { [AGENT_TOKEN_ENV_VAR]: token };
  } catch (err) {
    // Log the agent, never the token, and let the spawn proceed unattributed.
    logger.warn('[agent-identity] Could not mint a session token', {
      agentPath,
      err: String(err),
    });
    return {};
  }
}

/**
 * The tier ceiling to stamp on a freshly minted token, as a spreadable fragment
 * so an agent with no ceiling passes nothing and takes `mint()`'s default.
 *
 * `.dork/agent.json` is the source of truth (ADR-0043). When it cannot be read —
 * missing, malformed, or refused by the filesystem — the agent's LAST RECORDED
 * ceiling is used instead, rather than nothing. That fallback is the whole
 * reason this is not two lines inline: taking the default on an unreadable
 * manifest would mean an agent limited to `observe` gets an unrestricted token
 * the moment somebody fat-fingers its manifest, and a limit you can delete your
 * way out of is not a limit. A directory that simply hosts no agent has no
 * recorded ceiling either, so it still passes nothing.
 *
 * @param agentPath - Absolute path to the agent's project directory.
 * @param service - The identity service, for the last-recorded fallback.
 * @returns `{ tierCeiling }`, or `{}` when no ceiling is recorded anywhere.
 */
async function resolveTierCeiling(
  agentPath: string,
  service: AgentIdentityService
): Promise<{ tierCeiling?: CapabilityTier }> {
  const manifest = await readManifest(agentPath, logger);
  if (manifest) {
    return manifest.tierCeiling ? { tierCeiling: manifest.tierCeiling } : {};
  }

  const recorded = await service.describeAgent(agentPath);
  if (!recorded) return {};

  logger.warn('[agent-identity] Manifest unreadable; keeping the recorded tier ceiling', {
    agentPath,
    tierCeiling: recorded.tierCeiling,
  });
  return { tierCeiling: recorded.tierCeiling };
}

/**
 * Build the invocation-context resolver for an in-session `dorkos` MCP server.
 *
 * In-session tools run IN PROCESS: the agent calls them from inside its own
 * session, so there is no HTTP request and no `X-DorkOS-Agent` header to
 * resolve. The caller is instead structurally known — it is the agent whose
 * session this is — so identity comes from the session's working directory.
 * This is the same reasoning `resolveSenderIdentity` uses for Relay.
 *
 * The lookup is memoized for the life of the server instance (one per SDK
 * query), so a session that makes twenty tool calls performs one indexed read,
 * not twenty. It resolves to `undefined` — leaving calls unattributed, exactly
 * as before — when the directory hosts no agent with a live token.
 *
 * @param agentPath - The session's working directory, or `undefined` when the
 *   server is built without a session (the external/introspection path).
 * @returns A memoized resolver for `capabilityMcpTools`.
 */
export function createInSessionContextResolver(
  agentPath: string | undefined
): () => Promise<CapabilityInvocationContext | undefined> {
  let pending: Promise<CapabilityInvocationContext | undefined> | undefined;

  return () => {
    pending ??= (async () => {
      if (!agentPath) return undefined;

      const service = getAgentIdentityService();
      if (!service) return undefined;

      try {
        const identity = await service.describeAgent(agentPath);
        return identity ? { identity } : undefined;
      } catch (err) {
        // Attribution is a side channel: never fail the agent's tool call.
        logger.debug('[agent-identity] In-session identity lookup failed', {
          agentPath,
          err: String(err),
        });
        return undefined;
      }
    })();
    return pending;
  };
}
