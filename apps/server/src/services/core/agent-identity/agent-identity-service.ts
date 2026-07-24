/**
 * Per-agent identity tokens: mint, resolve, revoke (spec `agent-trust` §3.1).
 *
 * An agent that acts on DorkOS through an agent-facing surface — `dorkos call`,
 * the `/api/capabilities/:id/invoke` endpoint, the external `/mcp` server —
 * looks exactly like the human operator today. This service gives each agent a
 * bearer token so those calls can be ATTRIBUTED. It is deliberately not a
 * transport credential: identity is never required, and a request without one
 * behaves exactly as it does today (spec §3.1, resolved open question).
 *
 * ## The secret exists in exactly one place at rest: nowhere
 *
 * {@link AgentIdentityService.mint} generates 128 bits of CSPRNG randomness,
 * hands the hex string to its single caller, and persists only the SHA-256
 * digest. Nothing can read a usable token back out of the database, and
 * `agent.json` never sees it. Resolution hashes the presented token and looks
 * the digest up, so the comparison never needs the plaintext either.
 *
 * ## Lifecycle: mint per spawn, revoke per agent
 *
 * Because a hash cannot be reversed, an already-minted secret can never be
 * handed out a second time — so the runtime env seam mints a FRESH token each
 * time it spawns a session (see `agent-token-env.ts`). Tokens therefore
 * accumulate per agent, one per spawn, and all of them stay valid: concurrent
 * sessions for the same agent must not invalidate each other. That makes
 * revocation an `agentPath`-wide sweep ({@link AgentIdentityService.revoke}),
 * which is also the semantics an operator wants — "this agent no longer acts as
 * itself" — rather than per-session bookkeeping they never see.
 *
 * @module services/core/agent-identity/agent-identity-service
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, agentIdentityTokens, type Db } from '@dorkos/db';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

/** Bytes of CSPRNG randomness behind a minted token (128 bits, per spec §3.1). */
const TOKEN_BYTES = 16;

/**
 * A resolved agent identity — who is acting, and the highest tier they may
 * reach. Carries no token material.
 */
export interface AgentIdentity {
  /** Absolute path to the agent's project directory — the stable agent identity. */
  agentPath: string;
  /** Human-readable agent name, for Activity attribution labels. */
  displayName: string;
  /**
   * Highest capability tier this identity may reach. Declared here and carried
   * onto every request; enforcement lands in a later task (spec §3.2).
   */
  tierCeiling: CapabilityTier;
  /** When the presented token was minted. ISO 8601 UTC. */
  createdAt: string;
}

/** What {@link AgentIdentityService.mint} needs to describe a new identity. */
export interface MintAgentTokenInput {
  /** Absolute path to the agent's project directory. */
  agentPath: string;
  /** Human-readable agent name. */
  displayName: string;
  /**
   * Highest tier the identity may reach. Defaults to `destructive`
   * (unrestricted), which preserves today's trust posture — tokens exist to
   * attribute, not yet to restrict.
   */
  tierCeiling?: CapabilityTier;
}

/** Hash a token exactly as it is stored: SHA-256, lowercase hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Mint, resolve, and revoke the per-agent tokens that let DorkOS attribute an
 * agent's actions. See the module TSDoc for the hashing and lifecycle contract.
 */
export class AgentIdentityService {
  /**
   * Build the service over a database handle.
   *
   * @param db - The DorkOS database handle.
   */
  constructor(private readonly db: Db) {}

  /**
   * Mint a fresh token for an agent and persist only its hash.
   *
   * The returned plaintext is the ONLY time this value is available; it is not
   * recoverable afterwards by design. Existing tokens for the same agent stay
   * valid (see the module TSDoc on concurrent sessions).
   *
   * @param input - The agent to mint for, and its optional tier ceiling.
   * @returns The plaintext token to hand to exactly one caller.
   */
  async mint(input: MintAgentTokenInput): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.db.insert(agentIdentityTokens).values({
      tokenHash: hashToken(token),
      agentPath: input.agentPath,
      displayName: input.displayName,
      tierCeiling: input.tierCeiling ?? 'destructive',
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    return token;
  }

  /**
   * Resolve a presented token to the identity behind it, or `undefined` when it
   * is unknown, malformed, or revoked.
   *
   * Lookup is by hash, so an attacker with database read access still holds
   * nothing presentable. The final equality check runs through
   * {@link timingSafeEqual} so a caller cannot learn a valid digest by
   * measuring how long a miss takes.
   *
   * @param token - The raw token from the `X-DorkOS-Agent` header.
   * @returns The resolved identity, or `undefined` when it does not resolve.
   */
  async resolve(token: string): Promise<AgentIdentity | undefined> {
    if (!token) return undefined;

    const digest = hashToken(token);
    const [row] = await this.db
      .select()
      .from(agentIdentityTokens)
      .where(and(eq(agentIdentityTokens.tokenHash, digest), isNull(agentIdentityTokens.revokedAt)))
      .limit(1);

    if (!row) return undefined;

    // The index lookup already matched on equality; this constant-time compare
    // is the belt-and-braces guard so no timing signal rides on the comparison.
    const presented = Buffer.from(digest, 'hex');
    const stored = Buffer.from(row.tokenHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return undefined;
    }

    return {
      agentPath: row.agentPath,
      displayName: row.displayName,
      tierCeiling: row.tierCeiling,
      createdAt: row.createdAt,
    };
  }

  /**
   * Revoke every live token belonging to an agent.
   *
   * Rows are marked, never deleted, so a revoked token stays auditable. Already
   * revoked rows are left untouched and do not count toward the total.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @returns How many live tokens this call revoked.
   */
  async revoke(agentPath: string): Promise<number> {
    const revokedAt = new Date().toISOString();
    const live = await this.db
      .select({ tokenHash: agentIdentityTokens.tokenHash })
      .from(agentIdentityTokens)
      .where(
        and(eq(agentIdentityTokens.agentPath, agentPath), isNull(agentIdentityTokens.revokedAt))
      );

    if (live.length === 0) return 0;

    await this.db
      .update(agentIdentityTokens)
      .set({ revokedAt })
      .where(
        and(eq(agentIdentityTokens.agentPath, agentPath), isNull(agentIdentityTokens.revokedAt))
      );

    return live.length;
  }
}

/**
 * The process-wide service, initialized at boot before the Express app is
 * built. Mirrors the auth module's `initAuth`/`getAuth` singleton so the
 * resolution middleware — which is mounted inside `createApp()`, where no
 * database handle is in scope — can reach it lazily.
 */
let service: AgentIdentityService | undefined;

/**
 * Initialize the process-wide agent-identity service.
 *
 * @param db - The DorkOS database handle.
 * @returns The initialized service.
 */
export function initAgentIdentityService(db: Db): AgentIdentityService {
  service = new AgentIdentityService(db);
  return service;
}

/**
 * The process-wide agent-identity service, or `undefined` when it was never
 * initialized (unit tests that build the app without a database). Callers must
 * treat `undefined` as "no identity available" and carry on unattributed —
 * identity is never required.
 *
 * @returns The service, or `undefined`.
 */
export function getAgentIdentityService(): AgentIdentityService | undefined {
  return service;
}

/**
 * Reset the singleton. Test-only seam, mirroring the auth module.
 */
export function resetAgentIdentityService(): void {
  service = undefined;
}
