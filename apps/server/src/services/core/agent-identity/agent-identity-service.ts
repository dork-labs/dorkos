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
 * ## Tokens expire, and why by time rather than by session
 *
 * A token that never expires is a standing credential: one minted for a
 * five-minute session last month would still act as that agent today, and once
 * tiers are enforced against identity that is a real bypass surface, not a
 * bookkeeping wart. Two clocks close it (see {@link TOKEN_IDLE_TTL_MS} and
 * {@link TOKEN_ABSOLUTE_TTL_MS}): a token dies after a stretch of not being used,
 * and dies outright once it is old enough, whichever comes first.
 *
 * Scoping tokens to the session they were minted for was the alternative, and it
 * is weaker in practice. The mint seam runs at spawn, before a session id exists
 * to bind to; sessions resume, fork, and are killed without any teardown hook
 * that reliably fires, so "revoke when the session ends" would silently leak
 * exactly the tokens it was meant to collect. A clock needs no event to fire.
 *
 * Expiry is a property of the BEARER path only. {@link AgentIdentityService.resolve}
 * enforces it, because a presented secret is what expiry protects against.
 * {@link AgentIdentityService.describeAgent} does not: it presents no secret (the
 * caller is structurally the agent whose session it is) and exists to read the
 * agent's recorded tier ceiling. Letting a stale clock erase an in-session
 * agent's identity would silently turn OFF its tier ceiling, which is the
 * opposite of what expiry is for. Revocation, the operator's actual off switch,
 * applies to both.
 *
 * @module services/core/agent-identity/agent-identity-service
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, agentIdentityTokens, type Db } from '@dorkos/db';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

/** Bytes of CSPRNG randomness behind a minted token (128 bits, per spec §3.1). */
const TOKEN_BYTES = 16;

/**
 * How long a token may go unused before it stops resolving.
 *
 * Long enough that an agent picked back up after a weekend keeps its identity,
 * short enough that tokens from sessions nobody remembers are already dead.
 */
export const TOKEN_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The hard ceiling on a token's life, however often it is used. Bounds how long
 * any single minted secret can matter, even for an agent that never stops.
 */
export const TOKEN_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale the recorded `lastUsedAt` must be before resolution rewrites it.
 *
 * Refreshing on every request would add a write to every attributed API call for
 * no benefit — the idle window is measured in days, so minutes of drift cost
 * nothing and a busy agent writes once per interval instead of once per call.
 */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

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
   * Highest capability tier this identity may reach. Carried onto every request
   * and enforced by `enforceCapabilityTier`: a ceiling below a capability's tier
   * refuses the call outright, and no approval can lift it.
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
   * (unrestricted), so minting a token attributes an agent without narrowing what
   * it may do; a lower ceiling is how an operator narrows it.
   */
  tierCeiling?: CapabilityTier;
}

/** Hash a token exactly as it is stored: SHA-256, lowercase hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** How many digest characters identify a token in a log line. */
const DIGEST_PREFIX_LENGTH = 8;

/**
 * A short, non-reversible label for a presented token, for logs.
 *
 * Operators need to tell "the same revoked agent keeps retrying" from "several
 * different bad tokens", and that needs a stable handle. A digest prefix gives one
 * without ever putting the credential in a log file: it cannot be presented, and
 * eight hex characters of a SHA-256 digest identify nothing on their own.
 *
 * @param token - The presented token.
 * @returns The first characters of its SHA-256 digest.
 */
export function agentTokenDigestPrefix(token: string): string {
  return hashToken(token).slice(0, DIGEST_PREFIX_LENGTH);
}

/** A stored token row, as Drizzle infers it. */
type AgentTokenRow = typeof agentIdentityTokens.$inferSelect;

/**
 * Whether a stored token has run out of time — idle too long, or simply too old.
 *
 * Reads both clocks off `createdAt`/`lastUsedAt` rather than a stored expiry, so
 * tokens minted before expiry existed are covered by the same rule with no
 * backfill: one that has not been used since before the idle window is already
 * dead the moment this ships.
 */
function isTokenExpired(row: AgentTokenRow, now: number): boolean {
  const createdAt = new Date(row.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  if (now - createdAt > TOKEN_ABSOLUTE_TTL_MS) return true;

  const lastUsedAt = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : createdAt;
  const lastActivity = Number.isNaN(lastUsedAt) ? createdAt : lastUsedAt;
  return now - lastActivity > TOKEN_IDLE_TTL_MS;
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
      lastUsedAt: null,
      revokedAt: null,
    });
    return token;
  }

  /**
   * Resolve a presented token to the identity behind it, or `undefined` when it
   * is unknown, malformed, revoked, or expired.
   *
   * Lookup is by hash, so an attacker with database read access still holds
   * nothing presentable. The final equality check runs through
   * {@link timingSafeEqual} so a caller cannot learn a valid digest by
   * measuring how long a miss takes. A token that still resolves has its
   * `lastUsedAt` refreshed, which is what keeps a live agent's token alive (see
   * the module TSDoc on expiry).
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

    const now = Date.now();
    if (isTokenExpired(row, now)) return undefined;

    await this.touch(row, now);

    return {
      agentPath: row.agentPath,
      displayName: row.displayName,
      tierCeiling: row.tierCeiling,
      createdAt: row.createdAt,
    };
  }

  /**
   * Refresh a live token's `lastUsedAt`, but only once the stored value is stale
   * enough to be worth a write (see {@link LAST_USED_WRITE_INTERVAL_MS}).
   *
   * Failures are swallowed: attribution is a side channel, and a write that loses
   * a race only costs the token a few minutes off a multi-day window.
   *
   * @param row - The resolved token row.
   * @param now - The current epoch milliseconds.
   */
  private async touch(row: AgentTokenRow, now: number): Promise<void> {
    const recorded = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Number.isFinite(recorded) && now - recorded < LAST_USED_WRITE_INTERVAL_MS) return;

    try {
      await this.db
        .update(agentIdentityTokens)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(agentIdentityTokens.tokenHash, row.tokenHash));
    } catch {
      // Deliberately ignored — see the TSDoc above.
    }
  }

  /**
   * The identity of the agent rooted at `agentPath`, taken from its most
   * recently minted live token, or `undefined` when it holds none.
   *
   * This is the in-session counterpart to {@link resolve}. Tools the agent runs
   * inside its own session reach DorkOS in-process, with no HTTP hop to carry a
   * token — but the caller is structurally known to be the agent whose session
   * it is. Reading the stored record (rather than synthesizing one) means the
   * in-session path sees the SAME `tierCeiling` the token path would, so the two
   * surfaces cannot drift once that ceiling is enforced.
   *
   * Deliberately ignores token expiry, unlike {@link resolve}: nothing is being
   * presented here, so there is no bearer secret to age out, and dropping the
   * identity would drop the agent's tier ceiling along with it (see the module
   * TSDoc). Revocation still applies — that is the operator's real off switch,
   * now that DOR-490 gives it a production caller.
   *
   * **Residual risk noted in DOR-490's review, unresolved by that change.**
   * `undefined` here does not mean "no privilege" to the caller —
   * `tier-enforcement.ts`'s `enforceCapabilityTier` reads
   * `identity?.tierCeiling ?? gate?.anonymousTierCeiling ??
   * DEFAULT_ANONYMOUS_TIER_CEILING` ('destructive', the WIDEST ceiling, applied
   * to every caller that does not identify itself). So a mid-session
   * revocation only narrows an agent's ceiling today because every minted
   * token happens to carry that same anonymous default. The moment any caller
   * mints a token with a LOWER explicit `tierCeiling`, revoking it mid-session
   * would WIDEN that agent's effective power rather than shutting it off —
   * exactly backward from what revocation is for. Closing this needs
   * `enforceCapabilityTier` to treat "this agentPath is known but revoked"
   * differently from "this caller never identified itself," which this method
   * cannot express on its own (it returns the same `undefined` for both).
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @returns The agent's current identity, or `undefined` when it has no live token.
   */
  async describeAgent(agentPath: string): Promise<AgentIdentity | undefined> {
    if (!agentPath) return undefined;

    const [row] = await this.db
      .select()
      .from(agentIdentityTokens)
      .where(
        and(eq(agentIdentityTokens.agentPath, agentPath), isNull(agentIdentityTokens.revokedAt))
      )
      .orderBy(desc(agentIdentityTokens.createdAt))
      .limit(1);

    if (!row) return undefined;

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
