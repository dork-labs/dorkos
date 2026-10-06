# Audit trail

The audit log is one append-only, hash-chained table, `audit_events`, that records every action on a DorkOS server: who acted, on what, when, and how it came out. It is the record "trusted by default" rests on, so it has to be complete before any permission gate is loosened. Spec: `specs/audit-trail/02-specification.md`.

## Where things live

| Piece                          | File                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| Table, CHECK constraints       | `packages/db/src/schema/audit/audit-events.ts`                          |
| Migration + the three triggers | `packages/db/drizzle/20261006231015_audit_events.sql`                   |
| Wire shapes                    | `packages/shared/src/audit-schemas.ts` (`@dorkos/shared/audit-schemas`) |
| The one writer                 | `apps/server/src/services/audit/audit-log.ts` (`AuditLog`)              |
| Canonical JSON for the hash    | `apps/server/src/services/audit/canonical-json.ts`                      |
| Stable actor ids               | `apps/server/src/services/audit/account-ids.ts` (`AccountIds`)          |
| Activity → audit copy          | `apps/server/src/services/audit/activity-tee.ts`                        |
| `audit.verify` capability      | `apps/server/src/services/audit/audit-capabilities.ts`                  |
| `GET /api/audit/verify`        | `apps/server/src/routes/audit.ts`                                       |

## The invariants

1. **Append-only, enforced by SQLite.** `BEFORE UPDATE` and `BEFORE DELETE` triggers abort. Never write a code path that updates or deletes an audit row; there is no prune.
2. **The chain is enforced on insert.** A `BEFORE INSERT` trigger refuses a row whose `seq` is not `max + 1` or whose `prev_hash` is not the last row's `hash`. Only `AuditLog.record` computes those, inside one `IMMEDIATE` transaction. Do not insert into `audit_events` any other way.
3. **The hash contract.** `hash = sha256(prev_hash + canonicalJson(hashInput(row)))`. `hashInput` lists every column except `hash`, keyed by SQL column name, with NULL as `null`. Adding a column to `hashInput` changes what every existing row hashes to, so `verify` would call the whole log tampered. A new column must leave old rows hashing exactly as before (for example, include its key only when it is not NULL), and a test must prove an old row still verifies.
4. **Actors are stable ids.** Never record an agent's path or the word "You". Use `AccountIds`: an agent is its mesh ULID (read from the `agents` table, so it works before the mesh boots), an unregistered agent is `unregistered:<hash>`, the owner is their account id or `install:<install id>`.
5. **Redaction is the writer's job.** `record` sweeps every free-text field for credential shapes and empties the values of any `change` on a `SENSITIVE_CONFIG_KEYS` field. Pass raw values; do not pre-redact. Redaction is a net, not a licence: never put a secret's value in `summary`; write "used secret X".
6. **`record` never throws.** It logs a warn and returns `undefined`, so a failing audit write cannot fail the action it records.

## One or the other, never both

A choke point records an action in ONE of two ways:

- It writes Activity (`activityService.emit`). The tee copies the row into the audit log with `links.activityId`.
- It calls `auditLog.record(...)` directly, for actions that have no place in the human feed.

Doing both records the action twice. If you add a direct `record` call next to an existing `emit`, remove one of them.

## Adding a choke point

1. Decide the action name (`domain.verb`, matching Activity's style), the `operation`, and the target.
2. Resolve the actor through `AccountIds`. Prefer the identity the request or turn already resolved over guessing.
3. Choose `visibility`: `space` for actions (the default and almost always right), `admins` for security records such as sign-in IPs, `participants` only for something scoped to a private conversation (name the participants).
4. Write a test that the action produces exactly one row with the right actor, and run it once with your call removed to prove it fails.

## Checking the chain

`AuditLog.verify({ fromSeq?, limit? })` walks the chain and names the first break. It is exposed as the `audit.verify` capability (`audit_verify` on both MCP servers, `dorkos call audit.verify`, `GET /api/audit/verify`). The server also checks the last 1,000 rows at startup and warns if they break.

The triggers stop the app, not somebody with `sqlite3` and the file; the chain makes such an edit detectable afterwards. Proving it needs a checkpoint stored somewhere a local agent cannot write, which is a follow-up in the spec.

## Activity retention

Activity keeps `activity.retentionDays` days (default 365; `DORKOS_ACTIVITY_RETENTION_DAYS` overrides). The `permissions` category is never pruned. The audit log is never pruned.
