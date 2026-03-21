# Dorkian Explainers

Quick, simple explanations of dev concepts (DorkOS-specific).

---

## Relay Endpoints

**What:** Named message destinations — like mailboxes. Each one has a subject string (e.g., `relay.agent.backend`) and a physical Maildir folder on disk where messages land.

**When created:** You register them. This can happen via the API (`POST /api/relay/endpoints`), in code (`relayCore.registerEndpoint(subject)`), or automatically when adapters start up. Registration creates the folder structure and starts a file watcher.

**How routing works:** You publish a message to a subject. Relay finds the matching endpoint, writes the message into its `new/` folder, and triggers any subscription handlers listening on that subject. After delivery, the message moves to `cur/` (or `failed/` if something went wrong).

**Key distinction:** Endpoints are concrete addresses (no wildcards). Subscriptions can use patterns like `relay.agent.>` to listen to many endpoints at once.

**What actually uses endpoints:**

| System                 | Uses Endpoints? | How it works instead                                     |
| ---------------------- | --------------- | -------------------------------------------------------- |
| Chat UI → Agent        | No              | Direct `runtime.sendMessage()` + SSE                     |
| Slack/Telegram inbound | No              | `BindingRouter` does a DB lookup, calls runtime directly |
| Tool approvals         | No              | Direct `runtime.approveTool()`                           |
| Pulse (scheduler)      | Yes             | Publishes to `relay.system.pulse.*`                      |
| Agent-to-agent         | Yes             | Publishes to `relay.agent.*`                             |
| Mesh discovery         | Yes             | Registers `relay.agent.{namespace}.{id}`                 |

**Bottom line:** Endpoints are for async inter-system messaging (scheduler dispatching jobs, agents talking to agents). The primary chat flow bypasses Relay entirely.

**Why Pulse uses Relay instead of calling agents directly:**
Pulse actually has _both_ paths — `executeRunViaRelay()` (preferred when Relay is enabled) and `executeRunDirect()` (fallback). The Relay path gives: fire-and-forget with delivery confirmation (no need to hold a connection), decoupling (Pulse doesn't need to know which agent handles the job), crash resilience (messages persist on disk), budget enforcement (TTL, hop limits), and auditability (every dispatch is a file you can inspect). The direct path works fine but lacks these properties.

**Where on disk:**

- Production: `~/.dork/relay/mailboxes/{hash}/`
- Dev: `apps/server/.temp/.dork/relay/mailboxes/{hash}/`

The folder name is a truncated SHA-256 hash of the subject string (12 chars). Inside each: `tmp/` (staging), `new/` (unread), `cur/` (delivered), `failed/` (errors).

**Identifying a mailbox:** The hash is one-way — you can't reverse it. The subject-to-hash mapping only exists in memory while the server runs. To identify a stopped mailbox, read a message JSON inside it — each envelope has a `"subject"` field.

**Why hashes?** Filesystem safety (fixed length, no special chars). But subjects are already safe characters, so this may be over-engineered. No ADR exists for this choice — it was an implementation decision, not a deliberate tradeoff. Potential improvement: use subjects directly as folder names, or keep hashes but add a `manifest.json` mapping.

---

## Feature Flags (Relay & Pulse)

**Both are off by default** for fresh installs. They get enabled through onboarding or by editing `config.json`.

**How they're checked** (in `apps/server/src/index.ts`):

- Pulse: `env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled` — env var OR config
- Relay: env var wins if explicitly set in `process.env`, otherwise `relayConfig?.enabled ?? false`

**Your dev config** (`apps/server/.temp/.dork/config.json`) has both set to `true`, so they're active in your dev environment.

**When Relay is off**, Pulse falls back to `executeRunDirect()` which calls `agentManager.sendMessage()` directly — no mailboxes involved.

---

## Maildir (the `tmp/`, `new/`, `cur/`, `failed/` pattern)

**What:** A standard email storage format from the 1990s (created by djb for qmail). Each message is a separate file, and delivery safety comes from atomic `rename()` between directories.

**The flow:** Write to `tmp/` (incomplete) → rename to `new/` (ready, unread) → rename to `cur/` (claimed/processed). Crash at any point? No partial messages — a file is either fully in one directory or not.

`**cur` = "current"\*\* — it means "current mail that has been seen." In Relay's case, it means "delivered and processed."

`**failed/` is a DorkOS addition\*\* — not part of the original Maildir spec. Messages that couldn't be delivered land here with a `.reason.json` companion file.

**Why Relay uses it:** File-per-message means you can inspect with `ls` and `cat`. Atomic renames mean crash-safe delivery. Widely battle-tested by mail servers (Dovecot, Postfix, etc.). See ADR-0010 and ADR-0013.

---

## Dots in Folder Names

Dots are legal in directory names on all modern filesystems (APFS, ext4, NTFS, FAT32). The only quirk: Windows silently strips a _trailing_ dot (`relay.` becomes `relay`). Dots in the middle are fine everywhere. The problematic characters are `\ / : * ? " < > |` and null — Relay subjects use none of these.

---

## Failed Runs (Pulse)

**What:** A Pulse scheduled job that didn't complete successfully. The run record gets `status: 'failed'` with an error message and timestamp.

**Common causes:** Agent not found in the registry, no Relay receiver subscribed (`deliveredTo === 0`), agent errors out mid-task, or server crashes while a run is in progress.

**Crash recovery:** On startup, Pulse marks any runs still in "running" status as failed — if the server died, those runs didn't finish.

**Where to see them:** Via the Pulse API or in `PulseStore` (SQLite). Each run has a status lifecycle: `pending` → `running` → `completed` or `failed`.

---

## Agent-to-Agent Communication

**Discovery (Mesh):** Mesh scans directories for agent markers (`.claude/`, `.cursor/`, `.codex/`). Found agents get a `.dork/agent.json` manifest, a SQLite entry, and a Relay endpoint at `relay.agent.{namespace}.{agentId}`. Agents use `mesh_list` and `mesh_inspect` MCP tools to find each other at runtime.

**Namespace** (ADR-0032): Derived from directory structure — first path segment after the scan root. E.g., agent at `~/projects/dorkos/core` with scan root `~/projects` → namespace `dorkos`.

**Access control** (ADR-0033): Same-namespace agents can talk freely. Cross-namespace is denied by default. Explicit allow rules unlock specific paths.

**Three messaging patterns** (ADR-0077):

| Pattern         | MCP Tool         | When to use                        |
| --------------- | ---------------- | ---------------------------------- |
| Fire-and-forget | `relay_send`     | One-way, no reply needed           |
| Request/reply   | `relay_query`    | Blocks for a response, < 10 min    |
| Async dispatch  | `relay_dispatch` | Returns an inbox to poll, > 10 min |

**How it flows:** Agent A calls `relay_query` → Relay routes to `relay.agent.{ns}.{id}` → Claude Code Adapter injects the message into Agent B's context → Agent B processes and replies → Relay delivers reply back to Agent A.

**Key ADRs:** 0032 (namespaces), 0033 (access control), 0043 (file-first agent storage), 0077 (three communication patterns).

---

## Dead Letters (Relay)

**What:** Messages that couldn't be delivered through the normal Relay pipeline. Instead of being silently dropped, they're preserved in a dead-letter queue with a reason explaining what went wrong.

**Common causes:** TTL expired (message too old), hop limit exceeded, or circuit breaker is open (endpoint is recovering from failures).

**Where they live:** In the endpoint's `failed/` directory, with a `.reason.json` companion file explaining why delivery failed. Also queryable via `relayCore.getDeadLetters()`.

**Analogy:** The postal service's "undeliverable mail" bin — the letter exists, it just couldn't reach its destination.

**Key difference from failed runs:** Failed runs = jobs that didn't complete (Pulse). Dead letters = messages that couldn't be delivered (Relay). Different systems, different problems.

---

## MCP Tools (33 total)

Tools that agents can call via the DorkOS MCP server. Defined in `apps/server/src/services/runtimes/claude-code/mcp-tools/`. Grouped by subsystem, conditionally available based on feature flags.

- **Core** (4): `ping`, `get_server_info`, `get_session_count`, `get_current_agent`
- **Mesh** (8): `mesh_discover`, `mesh_register`, `mesh_list`, `mesh_inspect`, `mesh_unregister`, `mesh_deny`, `mesh_status`, `mesh_query_topology`
- **Relay** (7): `relay_send`, `relay_query`, `relay_dispatch`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`, `relay_unregister_endpoint`
- **Adapters** (4): `relay_list_adapters`, `relay_enable_adapter`, `relay_disable_adapter`, `relay_reload_adapters`
- **Traces** (2): `relay_get_trace`, `relay_get_metrics`
- **Bindings** (3): `binding_list`, `binding_create`, `binding_delete`
- **Pulse** (5): `pulse_list_schedules`, `pulse_create_schedule`, `pulse_update_schedule`, `pulse_delete_schedule`, `pulse_get_run_history`

---

## TODOs

### [IN PROGRESS] Use subject strings as mailbox folder names instead of SHA-256 hashes

**Why:** The current hashed folder names (`02cdb2a9d371`, `00744772b841`, etc.) are opaque — you can't tell what endpoint a mailbox belongs to without reading a message inside it. The hash-to-subject mapping only lives in memory while the server runs. Subjects are already filesystem-safe (lowercase alphanumeric + dots), so the hashing adds no real safety benefit.

**Goal:** Replace `mailboxes/{sha256-hash}/` with `mailboxes/{subject}/` so that `ls` on the mailboxes directory shows human-readable names like `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP/` instead of `02cdb2a9d371/`.

**Read before starting:**

- `packages/relay/src/endpoint-registry.ts` — the `hashSubject()` function and `EndpointRegistry` class. This is the primary file to change. The `hash` field on `EndpointInfo` and its usage throughout will need updating.
- `packages/relay/src/types.ts` — the `EndpointInfo` type definition (has a `hash` field that may need renaming or repurposing).
- `packages/relay/src/relay-publish.ts` — uses `hashSubject()` for dead-letter queue routing and endpoint matching.
- `packages/relay/src/adapter-delivery.ts` — uses `hashSubject()` to compute `endpointHash` for adapter delivery.
- `packages/relay/src/sqlite-index.ts` — stores and queries by `endpointHash`. The column/index may need renaming.
- `packages/relay/src/__tests__/endpoint-registry.test.ts` — existing tests for the registry and hash function.
- `decisions/0010-use-maildir-for-relay-message-storage.md` and `decisions/0013-hybrid-maildir-sqlite-storage.md` — context on the Maildir design.

**What to do:**

1. **Create an ADR** documenting this change and the reasoning (use `/adr:create`).
2. **Modify `endpoint-registry.ts`**: Instead of hashing the subject, use the subject string directly as the folder name. The `hashSubject()` function can either be removed or repurposed as a slug function that just returns the subject as-is (or with minimal sanitization as a safety net).
3. **Update `EndpointInfo`**: The `hash` field should become something like `dirName` or just use the subject directly. Trace all references.
4. **Update all consumers** of `hashSubject()` in `relay-publish.ts`, `adapter-delivery.ts`, and `sqlite-index.ts` to use the new naming.
5. **Update tests** — the endpoint registry tests assert on hash values; update to assert on subject-based folder names.
6. **No migration needed** — dev mailboxes in `apps/server/.temp/.dork/` can be deleted and recreated. For production, the mailboxes are ephemeral (re-registered on server start), so old hash-named folders just become orphans that can be cleaned up.
7. **Validate** that subject strings don't contain path separators (`/`, `\`) — the `validateSubject()` function in `subject-matcher.ts` should already enforce this, but confirm.

### [IN PROGRESS] Enable Relay, Mesh, and Pulse by default

**Why:** These are core DorkOS subsystems, not optional extras. A fresh install should have full functionality out of the box. Currently Relay and Pulse default to disabled and only activate through onboarding or manual config edits. Mesh is already always-on (ADR-0062) — Relay and Pulse should follow the same pattern.

**Goal:** New installations should have Relay and Pulse enabled without requiring any config changes or onboarding steps.

**Read before starting:**

- `apps/server/src/index.ts` (lines ~100-131) — the initialization logic where `pulseEnabled` and `relayEnabled` are computed from env vars and config. This is the primary code to change.
- `apps/server/src/services/pulse/pulse-state.ts` — Pulse feature flag holder
- `apps/server/src/services/relay/relay-state.ts` — Relay feature flag holder
- `apps/server/src/services/mesh/mesh-state.ts` — reference implementation. Mesh is always enabled via `isMeshEnabled = () => true` per ADR-0062. Relay and Pulse should follow this pattern.
- `packages/shared/src/config-schema.ts` — the `UserConfigSchema` where default values for `relay.enabled` and `scheduler.enabled` are defined. The defaults here may need to flip to `true`.
- `apps/server/src/env.ts` — `DORKOS_PULSE_ENABLED` and `DORKOS_RELAY_ENABLED` env var definitions (using `boolFlag` which defaults to `false`).
- `decisions/0054-invert-feature-flags-to-enabled-by-default.md` — may contain relevant prior reasoning about default-on flags.

**What to do:**

1. **Create an ADR** documenting the decision to enable all subsystems by default.
2. **Change config schema defaults**: In `UserConfigSchema`, set `relay.enabled` and `scheduler.enabled` to default to `true`.
3. **Update initialization logic** in `apps/server/src/index.ts`: The fallback for both should be `true` instead of `false`. Env vars should still be able to _disable_ them (e.g., `DORKOS_RELAY_ENABLED=false`).
4. **Update any tests** that assume these subsystems are disabled by default.
5. **Check onboarding flow**: If onboarding explicitly enables these, that step may become redundant — verify it still works correctly when the subsystem is already on.
6. **Note**: Mesh is already always-on (ADR-0062), no changes needed there.

### [TODO] Rename Relay MCP tools for clarity: relay_query → relay_send_and_wait, relay_dispatch → relay_send_async

relay_send, relay_query, and relay_dispatch all publish a message through the same relay.publish() codepath. The only difference between them is how they handle responses: relay_send expects no reply, relay_query blocks until a reply arrives, and relay_dispatch returns an inbox to poll later. The current names sound like synonyms for "send a message" and don't communicate the response strategy, which is the actual differentiator.

Rename:

- relay_query → relay_send_and_wait
- relay_dispatch → relay_send_async
- relay_send stays as-is

relay_send keeps its name because "send" correctly implies fire-and-forget. The two new names make the response pattern self-documenting: *and*wait = synchronous/blocking, \_async = returns immediately with a pollable inbox.

Scope:

- Tool name strings in apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts
- Tool descriptions in that same file (update any cross-references, e.g. "use relay_dispatch instead" → "use relay_send_async instead")
- Tool filter lists in apps/server/src/services/runtimes/claude-code/tool-filter.ts
- Context builder references in apps/server/src/services/runtimes/claude-code/context-builder.ts
- All test files that reference the old names
- Any specs, research, or docs that mention the old tool names

Do not rename the internal handler functions or factory functions (e.g. createRelayQueryHandler stays as-is) — only the user-facing tool name strings and their mentions in docs/tests/descriptions.
