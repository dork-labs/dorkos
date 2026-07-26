import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Standing permissions: one operator's answer to "stop asking about this agent
 * doing this thing", bounded by a clock (spec `agent-approval-settings` §3.2).
 *
 * A row is a ledger entry, not a cell in a matrix. It appears when a person
 * answers a real approval card and chooses to make that answer standing, so the
 * realistic size of this table is one row per agent a user actually trusts.
 *
 * ## Keyed on `agentPath`, not on an identity token
 *
 * Tokens are minted fresh on every spawn (`agent-token-env.ts`), so a
 * token-keyed permission would evaporate the next time the agent started. The
 * identity table keys on `tokenHash` for the opposite reason — one agent holds as
 * many live tokens as it has sessions — and states the consequence: revocation is
 * an `agentPath`-wide sweep. `agentPath` is what survives a respawn, so it is
 * what a standing permission has to be keyed on.
 *
 * ## Per agent, per capability, with no wildcard
 *
 * There is deliberately no value meaning "everything this agent might ask". The
 * set of gated actions is expected to grow, and a blanket permission granted
 * today would silently widen to cover actions added later — consent to something
 * smaller than what the person ends up with. A capability that becomes
 * destructive next month has no row here, so it asks.
 *
 * ## Absolute expiry, never sliding
 *
 * `expiresAt` is fixed when the permission is granted and is never pushed out by
 * use. A sliding window would hand the agent control of its own expiry: the agent
 * that acts most often would be the one that never has to ask again, which
 * inverts the property this table exists to preserve. Expiry is also evaluated on
 * READ, not only by the sweep, so a stale row is never honored just because no
 * cleanup has run.
 *
 * ## Operational state, not user-owned data
 *
 * Same reasoning as `approvals`: a creation time, an expiry, and a revocation are
 * operational state like task runs, never something a person edits by hand. It
 * also cannot live in `agent.json`, because the manifest on disk is canonical and
 * the mesh reconciler propagates it into the database with no integrity check —
 * an agent that can write a file would trust itself within five minutes.
 */
export const approvalGrants = sqliteTable(
  'approval_grants',
  {
    /** ULID identifying the standing permission. Safe to show a person. */
    id: text('id').primaryKey(),

    /** Absolute path to the agent's project directory — the stable agent identity. */
    agentPath: text('agent_path').notNull(),

    /** The one capability this covers, e.g. `marketplace.uninstall`. */
    capabilityId: text('capability_id').notNull(),

    /** When the operator granted it. ISO 8601 UTC. */
    grantedAt: text('granted_at').notNull(),

    /** When it stops being honored. ISO 8601 UTC. Absolute; never extended. */
    expiresAt: text('expires_at').notNull(),

    /** The `decidedBy` label from `resolveDecisionAuthority` — an account id. */
    grantedBy: text('granted_by').notNull(),

    /**
     * The decision posture this permission was created under, recorded per
     * decision rather than read back from live config, so an audit line says what
     * was true at the time.
     */
    posture: text('posture', {
      enum: ['signed-in-operator', 'local-trust'],
    }).notNull(),

    /** The approval card it came from, or null when created in Settings. */
    sourceApprovalId: text('source_approval_id'),

    /** When it was revoked, or null while it is live. ISO 8601 UTC. */
    revokedAt: text('revoked_at'),
  },
  (table) => [
    // The lookup the tier gate makes on every gated invocation by an identified
    // caller: one indexed hit on the pair.
    index('idx_approval_grants_agent_capability').on(table.agentPath, table.capabilityId),
    index('idx_approval_grants_expires_at').on(table.expiresAt),
  ]
);
