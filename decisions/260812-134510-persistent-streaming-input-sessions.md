---
id: 260812-134510
title: Persistent streaming-input sessions for claude-code, with resume as the recovery path
status: accepted
created: 2026-08-12
spec: persistent-session-runtime
supersedes: null
amends: null
superseded-by: null
---

# 260812-134510. Persistent streaming-input sessions for claude-code, with resume as the recovery path

## Status

Accepted — implemented by spec `persistent-session-runtime` phase P3 (PRs #975, #976, #979, #980, #981, #982, #983, #993).

This is the process-model half of the persistent-session work. Its companion is [ADR 260811-184735](260811-184735-server-owned-durable-message-queue.md) (the server-owned durable message queue, "ADR-c"), which owns the queue that survives the reap this ADR introduces. Read together: the queue makes a message durable, and this ADR makes the process that consumes it warm. Neither is safe without the other — a warm process that dropped queued work on a reap, or a durable queue feeding a cold subprocess every turn, would each miss the point.

## Context

The claude-code runtime ran **resume-per-message plus held-stream-within-turn**. Every turn built a fresh SDK `query()`, resumed the prior SDK session, held stdin open only long enough to answer control requests inside that one turn, and closed the process on the first `result`. The subprocess, its MCP connections, and its prompt cache therefore lived and died inside a single turn. Turn two of a conversation paid for a fresh subprocess, a fresh MCP handshake, and a cold prompt cache all over again.

That shape did not just cost latency and cache; it bred a family of fragilities that only existed because resume ran on the hot path of every message:

- **Anchor hacking.** The CLI's resume classifier will inject a synthetic "continue" turn if it decides a resumed session was mid-thought. DorkOS had to plant an anchor to stop it — a workaround whose only job was to talk the CLI out of a turn nobody asked for.
- **Substring-matched resume-failure retries.** A resume that failed was detected by matching against error-message substrings, and the recovery was to restart the session **as new**. A brittle string match sat between a person's conversation and its own history.
- **The canonical-id rebind.** When a new session gained its real id, the rebind had to move every consumer to the new id **mid-turn**. That dance cost two incidents (DOR-493, DOR-838).

None of these are bugs in isolation; they are the tax of doing a recovery operation — resume — on every single message instead of only when recovery is actually needed.

## Decision

**One persistent `query()` per ACTIVE claude-code session, with `WARM` as a real state, an idle timer that closes the process, and resume demoted to the recovery path.**

- A session's subprocess is held across turns. Between turns it sits in `WARM`: process up, MCP connections live, prompt cache hot, no turn open. `WARM` is a genuine state in the pump's state machine (`session-pump.ts`), not an accident of a `try/finally`. Making it real is the whole point — it is what buys warm cache, and later (P4) steering and staging.
- **Resume is demoted, not deleted.** It stops being the per-message mechanism and becomes exactly what it always should have been: the recovery path taken on a crash, a restart, or a cold start. The anchor hack, the substring-matched retry, and the rebind survive only there, off the hot path, where a session actually needs rebuilding from its transcript.
- This is a **per-session opt-in** (`runtimes.claudeCode.persistentSession`, shipped OFF). The capability flag `supportsPersistentSession: true` says the adapter **can** hold a process across turns, never that every session does; a default install still starts one process per message and `getSessionWarmth` honestly answers `cold`. Turning the opt-in on takes effect at a session's next message; turning it off does not retroactively cool a session that is already warm — it keeps its process until an idle reap, an eviction, a warm-ceiling reclaim, or a restart.

### The two-timer model, and why they must never be conflated

There are two independent timers, with two owners, and confusing them would either kill live conversations or leak subprocesses:

| Timer                | Constant                | Default | Owner                                        | What it retires                             |
| -------------------- | ----------------------- | ------- | -------------------------------------------- | ------------------------------------------- |
| **Process idle**     | `SESSIONS.WARM_IDLE_MS` | 5 min   | `SessionPump` (the claude-code adapter)      | the **process** — `WARM → REAPED`           |
| **Session eviction** | `SESSIONS.TIMEOUT_MS`   | 30 min  | `SessionStore.checkSessionHealth` (platform) | the **session record** — the person's place |

**Eviction implies a reap; a reap never implies eviction.** When a session record is evicted, its process is reaped first. But when a process is reaped for idleness, the record, the transcript, and the conversation are all untouched — the next message simply resumes into them and the person cannot tell anything happened.

That invisibility is exactly what makes the short window safe to set. Five minutes would be a reckless eviction timeout — it would throw away someone's place while they thought between turns. But it is a perfectly safe **reap** timeout precisely because a reap costs nothing observable: the only visible consequence is that the next turn pays a resume it would otherwise have skipped. Long enough to keep the warm cache across a pause for thought; short enough that a session abandoned mid-afternoon is not still holding a CLI subprocess and its MCP children at dinner.

### The warm ceiling is a separate number from the session ceiling, on purpose

`SESSIONS.MAX_WARM_SESSIONS` (default **12**) counts **processes**. `SESSIONS.MAX_SESSIONS` (default **50**) counts **session records**. They are deliberately different numbers because they are different kinds of limit:

- **Warmth is a cache, so it is LRU-rationed.** The thirteenth warm session does not fail; the least-recently-used warm process is reaped to make room, and a host is only refused when nothing is reclaimable — every process either mid-turn or parked on a person. LRU is exactly right for a cache, and fifty concurrent CLI subprocesses plus their MCP children on a laptop is not a shape to ship.
- **Session records are not a cache**, so `MAX_SESSIONS` stays a hard refusal ceiling — `ensureSession`'s throw remains the genuinely exceptional path it has always been.

Collapsing the two into one number would force a choice between refusing sessions too early (if 12) or holding too many subprocesses (if 50). Keeping them separate lets records stay generous while processes stay bounded.

### The relaunch pin list, and the account pin as a security control

A warm process pins whatever it was launched with. Change any pinned value and the next turn would silently run under stale settings unless the process is reaped and relaunched first. The pin list (`launch-fingerprint.ts`, `PIN_DISPOSITIONS`) is therefore exhaustive, and each field is classified as either **relaunch** (a change forces reap-and-relaunch) or **live** (a change is applied to the running process):

- **Relaunch pins:** `cwd`, the Claude **account root** (`CLAUDE_CONFIG_DIR`), the resolved credential env, the agent identity, the system-prompt append, `settingSources`, the rest of the process `env`, `effort` (with its `thinking` block), and `fastMode`.
- **Live pins:** `mcpServers` (`setMcpServers`), `plugins` (`reloadPlugins`), `permissionMode` (`setPermissionMode`), and `model` (`setModel`).

**The account pin is a security control, not an optimization detail.** A Claude account _is_ a config directory: it carries that account's transcripts and its own sign-in, so the account a process launched under is the account its work **bills to**. A dispatch that rode a process launched under a different account would bill a paying client's conversation to someone else. No other row has that consequence. So the account is compared **first and unconditionally**, ahead of any other pin and with no "these fingerprints are otherwise identical" shortcut in front of it, and again through the ordinary pin loop; a cross-account reuse is its own error class (`AccountPinViolationError`) because it is a security event, not a bug. Two string compares is a trivial price to never send someone else's invoice.

## Rejected alternatives

**Keep resume-per-message and queue only at our layer.** We could have taken the server-owned durable queue (ADR-c) and left the runtime on the old resume-per-message path — durable queueing without a warm process. Rejected because it discards most of the motivation. It leaves **every turn cold** — a fresh subprocess, a fresh MCP handshake, and a cold prompt cache on every message, exactly the cost this work exists to remove — and it makes **steering impossible**, because there is no live turn to inject into when the process only exists inside a single `result`. A durable queue in front of a cold runtime is a better waiting room for the same slow turn; it is not the feature.

## Non-goals

**The persistent process does not survive a DorkOS restart.** This is deliberate and inherited. ADR-0264 already accepts losing an in-flight turn when the server restarts; the pump takes that same boundary. On restart every warm process is gone, and the first message to each session recovers through resume — which is precisely why resume is kept rather than deleted. What _does_ survive a restart is the durable queue (ADR-c) and the session record and transcript; the warm process is the one thing that is allowed to be lost, because it is a cache and losing a cache is invisible once it refills.

The cross-runtime framing follows from this being a claude-code adapter fact. Codex (ADR-0309) and OpenCode (ADR-0308) do not become persistent; they keep their fresh-subprocess and sidecar models and declare `supportsPersistentSession: false`. Persistence is a property one adapter has, surfaced honestly through a capability flag, not a contract every runtime must meet — the same per-runtime-degradation stance as ADR-0310.

### The `priority` field (D3): we measured nothing, so we relied on nothing

The SDK exposes a `priority` field, and it was tempting to build turn-ordering on it. We did not. Even at `@anthropic-ai/claude-agent-sdk@0.3.224` the field carries **no prose documentation** — the only thing read out of the bundled binary is that the sole queue-driven abort keys on `priority: 'now'`, which nothing in the CLI enqueues and DorkOS never sets. Building on an undocumented field whose behavior we could only infer would be relying on something we never measured. So nothing in the pump reads or writes `priority`. This is recorded here rather than as an ADR of its own, because "we measured nothing and therefore relied on nothing" is a note, not a decision worth its own record.

## Consequences

### Positive

- Turn two of a conversation is materially faster than turn one: no spawn, no MCP reconnect, and a warm prompt cache. That performance claim is the justification for the work and is measured against the flag off and on (spec §Performance), not asserted.
- Resume's fragilities — the anchor hack, the substring-matched retry, the mid-turn rebind — are confined to the cold-start and recovery path. They stop running on every message and run only when a session genuinely needs rebuilding.
- `WARM` being a real state is what makes steering and staging (P4) possible at all; there is now a live turn and a live process to deliver into.
- A reap is invisible, so the 5-minute idle window is aggressive without being risky, and the warm ceiling can bound subprocess count without ever refusing a session.

### Negative

- A warm process holds memory — the subprocess and its MCP children — for its whole idle window. The warm ceiling bounds the total, but the resting footprint of an active host is higher than the old spawn-per-turn model, which held nothing between turns.
- LRU thrash is possible on a host with many simultaneously active sessions: a process reaped to make room, then immediately rewanted. The metric to watch is reap-then-immediately-rewarm frequency, and the remedy is raising the ceiling, not lengthening the idle timer.
- The pin list is now load-bearing correctness: a launch parameter added without a pin disposition would silently ride a stale warm process. `launch-fingerprint.test.ts` pins the disposition table against spec §4.5 so a new option fails a test rather than defaulting to "rides the warm process".
- The two paths — persistent and resume-per-message — run side by side behind a per-session flag, so the recovery path cannot be deleted and both must stay tested. That is the cost of a reversible, comparable rollout, and it is intended: a measurement run that flips the flag off must reap or restart before it can claim it is measuring the other path.
