import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Minted per-agent identity tokens (spec `agent-trust` §3.1).
 *
 * A row is the HASH of a token, never the token: `mint()` returns the 128-bit
 * secret to its one caller (the runtime env seam) and persists only its SHA-256
 * digest, so a database read can never recover a usable credential. `agent.json`
 * never holds the secret either — identity material lives here and nowhere else.
 *
 * ## Why this is its own table, not columns on `agents`
 *
 * `agents` is a DERIVED cache (ADR-0043): `agent.json` on disk is the source of
 * truth, and the mesh reconciler is licensed to delete the table and rebuild it
 * from files, re-registering every agent under a fresh ULID. Token material is
 * NOT derivable from `agent.json`, so a column on `agents` would be silently
 * destroyed by a routine rebuild and orphaned by the ULID churn. Keying on
 * `agentPath` — the stable filesystem identity the reconciler preserves and the
 * one Activity attributes to — survives both.
 *
 * The split also keeps hashes out of the table every agent-listing read path
 * selects from, so no existing query can leak identity material into an API
 * response or an agent-facing tool result.
 *
 * ## Many live tokens per agent
 *
 * `tokenHash` is the primary key and `agentPath` is merely indexed, so one agent
 * holds as many valid tokens as it has running sessions. Tokens are minted per
 * spawn (a hash cannot be reversed to re-hand out an existing secret), and
 * concurrent sessions for the same agent must not invalidate each other —
 * revocation is therefore an `agentPath`-wide sweep, not a single-row delete.
 */
export const agentIdentityTokens = sqliteTable(
  'agent_identity_tokens',
  {
    /** SHA-256 hex digest of the minted secret. The lookup key on resolve. */
    tokenHash: text('token_hash').primaryKey(),

    /** Absolute path to the agent's project directory — the stable agent identity. */
    agentPath: text('agent_path').notNull(),

    /** Human-readable agent name, denormalized for Activity attribution labels. */
    displayName: text('display_name').notNull(),

    /**
     * Highest capability tier this identity may reach, enforced at the capability
     * choke points; `destructive` (unrestricted) is the default and matches the
     * trust posture agents had before ceilings existed.
     */
    tierCeiling: text('tier_ceiling', {
      enum: ['observe', 'act', 'destructive'],
    })
      .notNull()
      .default('destructive'),

    /** When the token was minted. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),

    /**
     * When the token was last successfully presented, or null if never. ISO 8601
     * UTC.
     *
     * Together with `createdAt` this is what makes a token expire: resolution
     * refuses one that has been idle too long, or that is older than the absolute
     * cap, without needing an expiry column to backfill (see
     * `agent-identity-service.ts`). Written coarsely — only when the stored value
     * is already stale — so a busy agent costs one write every few minutes, not
     * one per request.
     */
    lastUsedAt: text('last_used_at'),

    /** When the token was revoked, or null while it is live. ISO 8601 UTC. */
    revokedAt: text('revoked_at'),
  },
  (table) => [index('idx_agent_identity_agent_path').on(table.agentPath)]
);
