import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Approval records for capability invocations that need a human's consent
 * (spec `agent-trust` §3.3).
 *
 * One row per request: an agent asks to do something destructive, the operator
 * grants or denies it in the cockpit, and the agent retries with the token it
 * was handed. The row is the whole state machine — `state` plus `decidedAt` and
 * `consumedAt` say exactly where a request stands, and nothing is deleted on
 * decision so an approval stays auditable after it is spent.
 *
 * ## Operational state, not user-owned data
 *
 * Approvals belong in SQLite rather than a file under `~/.dork/`: they are
 * short-lived derived state like task runs, meaningless once expired, and never
 * something a person edits by hand (spec §3.3, resolved open question).
 *
 * ## The token is never stored
 *
 * `tokenHash` holds the SHA-256 digest of the secret handed to the requester.
 * A database read can therefore never recover a usable token, exactly as the
 * agent-identity table treats its own material.
 *
 * ## Why `inputHash` is a column
 *
 * An approval is bound to `(capabilityId, inputHash)`, so consent to uninstall
 * one package can never be replayed to uninstall a different one. The hash is
 * computed over the canonical (key-sorted) form of the invocation input, so two
 * structurally-equal inputs always agree.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    /** ULID identifying the approval. Safe to show a person; carries no secret. */
    id: text('id').primaryKey(),

    /** SHA-256 hex digest of the token handed to the requester. */
    tokenHash: text('token_hash').notNull().unique(),

    /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
    capabilityId: text('capability_id').notNull(),

    /** Human-facing capability title, denormalized so the card needs no lookup. */
    capabilityTitle: text('capability_title').notNull(),

    /** Permission tier of the capability being requested. */
    tier: text('tier', {
      enum: ['observe', 'act', 'destructive'],
    })
      .notNull()
      .default('destructive'),

    /** Canonical hash of the invocation input this approval is bound to. */
    inputHash: text('input_hash').notNull(),

    /** Authenticated connector preflight digest, null for non-connector approvals. */
    authorityBindingDigest: text('authority_binding_digest'),
    /** Owner kind frozen by connector preflight, null for non-connector approvals. */
    connectorOwnerKind: text('connector_owner_kind', { enum: ['user', 'local_install'] }),
    /** Owner id frozen by connector preflight, null for non-connector approvals. */
    connectorOwnerId: text('connector_owner_id'),
    /** Stable agent frozen by connector preflight, null when no agent is involved. */
    connectorAgentId: text('connector_agent_id'),
    /** Canonical session frozen by connector preflight, null when no session is involved. */
    connectorSessionId: text('connector_session_id'),
    /** Exact connection frozen by connector preflight, null for non-connector approvals. */
    connectorConnectionId: text('connector_connection_id'),
    /** Exact operation revision frozen by connector preflight. */
    connectorOperationRevisionId: text('connector_operation_revision_id'),

    /** One plain sentence describing what the operator is about to allow. */
    summary: text('summary').notNull(),

    /**
     * The one argument a person has to read IN FULL before answering, verbatim,
     * or null when the capability declares none (DOR-1698).
     *
     * Separate from `summary` because the two answer different questions and are
     * bounded differently. The summary is a glanceable sentence, capped at 500
     * characters with every value inside it capped at 80 — which is right for
     * "which package", and wrong for "here is the new text of the file that
     * tells your agent what it must not do". Review reproduced the failure: a
     * 2000-character NOPE.md whose first 80 characters were the current
     * boundaries verbatim, with the part that undid them past the clamp.
     *
     * Only a capability that declares `approvalDetailField` produces one, so
     * this stays null for every approval that existed before it.
     */
    detail: text('detail'),

    /**
     * Which registry {@link subjectLabel} was read out of, or null when the
     * action names nothing.
     */
    subjectKind: text('subject_kind', {
      enum: ['agent', 'task', 'room', 'connection'],
    }),

    /**
     * The raw id the caller passed for the thing being acted on, or null.
     *
     * Kept beside the label rather than only inside `summary` because it is the
     * unforgeable half of the pair: every name a registry holds is one an agent
     * can usually edit, so the card shows the id too and a person can check one
     * against the other.
     */
    subjectId: text('subject_id'),

    /**
     * The registry's own name for {@link subjectId} at the moment the person was
     * asked, or null when nothing resolved.
     *
     * Stored rather than resolved at read time, which is the opposite of what
     * `tasks/task-provenance.ts` does with a proposer's name — and deliberately.
     * That module resolves fresh because a task list should credit an agent by
     * its CURRENT name. An approval is a record of a decision, and ADR
     * `260725-133221` binds it to the exact action SHOWN: if the agent renames
     * itself between the ask and the answer, the row must keep saying what the
     * person actually read.
     */
    subjectLabel: text('subject_label'),

    /**
     * Which surface an UNATTRIBUTED request arrived over, or null.
     *
     * Only meaningful while `requestedBy` is null — see the wire schema's
     * `origin`. Null on every row written before this column existed, which
     * renders exactly as those cards always did.
     */
    origin: text('origin', { enum: ['session', 'external-mcp'] }),

    /**
     * The arguments other than the subject, rendered, or null.
     *
     * Only ever written beside a subject — see the wire schema's
     * `otherArguments` for why a card needs this instead of re-reading
     * `summary`.
     */
    otherArguments: text('other_arguments'),

    /** Opaque label for who asked — an agent path, a display name, or null. */
    requestedBy: text('requested_by'),

    /**
     * The stable agent path of whoever asked, or null for an unidentified caller.
     *
     * Separate from `requestedBy` because that column is a display LABEL, built
     * from `displayName || agentPath` and swept for secrets, which makes it
     * unusable as a key. A standing permission keys on the agent path, so the
     * card it was created from has to carry the real one. Never rendered: the
     * card keeps showing the label.
     */
    requestedByPath: text('requested_by_path'),

    /** Where the request stands before it is spent. */
    state: text('state', {
      enum: ['pending', 'granted', 'denied'],
    })
      .notNull()
      .default('pending'),

    /** Why the operator said no, when they gave a reason. */
    denyReason: text('deny_reason'),

    /** When the request was created. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),

    /** When the token stops being honored. ISO 8601 UTC. */
    expiresAt: text('expires_at').notNull(),

    /** When the operator granted or denied. ISO 8601 UTC, null while pending. */
    decidedAt: text('decided_at'),

    /** When the token was spent or written off. ISO 8601 UTC; enforces single use. */
    consumedAt: text('consumed_at'),
  },
  (table) => [
    index('idx_approvals_state').on(table.state),
    index('idx_approvals_expires_at').on(table.expiresAt),
    index('approvals_connector_agent_connection_idx').on(
      table.connectorAgentId,
      table.connectorConnectionId,
      table.consumedAt
    ),
  ]
);
