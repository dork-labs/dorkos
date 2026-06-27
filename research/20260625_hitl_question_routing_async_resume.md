---
title: 'Human-in-the-Loop Question Routing & Async Resume for Autonomous Agents'
date: 2026-06-25
type: external-best-practices
status: active
tags:
  [
    flow,
    human-in-the-loop,
    question-routing,
    async-resume,
    linear,
    agent-accounts,
    polling,
    webhooks,
    identity-mode,
    calibration,
  ]
searches_performed: 67
sources_count: 30
related:
  [
    20260329_linear_api_agents_service_accounts.md,
    20260625_agent_auth_patterns_meta_harnesses.md,
    20260610_message_queuing_agent_runtimes.md,
  ]
---

# Human-in-the-Loop Question Routing & Async Resume

> Research for `/flow` spec #262 (`flow-triage-feeds-loop`), Pillar B. The question
> the loop must answer to run unattended: when a stage genuinely needs human input,
> how does it ask, where does the answer go, and how does the run resume, without
> coupling to Linear and without an exposed endpoint to receive webhooks?

## Why this matters for `/flow`

Discretionary questions in the `/flow` calibration ladder front-load into the intake
stages (TRIAGE, IDEATE, SPECIFY), peaking at IDEATE; execution stages (DECOMPOSE,
EXECUTE, VERIFY) proceed-and-log. So an unattended, full-autonomy loop hits a burst of
questions during shaping. If each parked question is a dead-end (no resume), the loop
stalls constantly. A working async-resume path is therefore a prerequisite for the
"no human needs to start a phase" posture, not a nice-to-have.

## Part 1: how agent frameworks implement durable async HITL resume

| System                | Primitive                                      | State persistence                                         | Answer delivery                                                    | Survives restart           | Push/Pull       |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- | --------------- |
| LangGraph             | `interrupt(v)` + `Command(resume=v)`           | Checkpointer (Sqlite/Postgres) keyed by `thread_id`       | Re-invoke same `thread_id` with `Command(resume=...)`              | Yes (durable checkpointer) | Pull            |
| Temporal              | `@signal` + `await wait_condition(...)`        | Append-only Event History, replayed on recovery           | Client sends a Signal to the workflow id                           | Yes (core guarantee)       | Push            |
| OpenAI Agents SDK     | `RunState` + `state.approve/reject`            | Caller-owned JSON blob in any store                       | Deserialize state, inject, re-run                                  | Yes (if blob stored)       | Pull            |
| Claude Agent SDK      | `canUseTool` (sync) OR `PreToolUse` -> `defer` | `defer`: pending call serialized to session JSONL on disk | `defer`: re-invoke `--resume <sessionId>` with the answer injected | `defer`: yes (JSONL)       | Pull            |
| AutoGen               | `UserProxyAgent.input_func` + `save_state`     | Explicit `team.save_state()`                              | Re-run team with the reply as new task                             | Only with manual save      | Pull            |
| CrewAI                | `human_input=True`                             | None native (stdin); workarounds use queues+DB            | stdin or custom executor                                           | No (native)                | Pull            |
| MCP / ACP elicitation | `elicitation/create`                           | None (connection-scoped)                                  | Client form returns on the same connection                         | No                         | Pull (sync RPC) |

**Three dominant architectures:**

1. **Durable workflow + signal** (Temporal): strongest durability, but requires an always-on cluster and an inbound signal path.
2. **Checkpointed graph + resume command** (LangGraph): durable via a DB checkpointer keyed by `thread_id`; resume is a re-invoke.
3. **Serialized run-state in an external store + pull-resume** (OpenAI Agents SDK, Claude SDK `defer`): minimal infra, the store can be anything (a DB, a queue, or a tracker issue), resume is a re-invoke that rehydrates state.

The Claude Agent SDK's **`defer`** decision is pattern 3 with a built-in primitive: a `PreToolUse`
hook returns `defer`, the SDK exits cleanly and serializes the pending tool call to the session
JSONL; later, `--resume <sessionId>` plus a hook that returns the answer for that `tool_use_id`
rehydrates the transcript byte-identically and continues with no visible gap. This is the durable,
server-optional mechanism that fits DorkOS's runtime directly. (Constraint: one tool call per turn;
emit questions as individual calls, not batches.)

## Part 2: how products route questions and detect replies

| Product                     | Channel                              | Waiting state                                       | Reply detection                                                   | Resume vs restart                               |
| --------------------------- | ------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Devin                       | Slack thread + web UI                | "Awaiting instructions" badge; `sleep` keyword      | Slack event wakes the sleeping session                            | Same live session (sleep/wake)                  |
| Cursor background agents    | Slack / dashboard / Linear           | "needs your input" notification; cannot ask mid-run | Slack events / dashboard poll                                     | Fire-and-forget; user re-invokes                |
| GitHub Copilot coding agent | Draft PR / issue comment             | 👀 reaction + draft PR                              | Webhook on `issue_comment`; `@copilot` triggers a new Actions run | New session, re-reads full thread               |
| Claude Code agent-view      | Local TUI dashboard / parent session | "Needs input" grouping; "N awaiting input"          | Poll the local TUI; parent-session forwarding                     | True JSONL session resume                       |
| Linear Agent Sessions       | Issue activity thread (native cards) | `awaitingInput` session status                      | Webhook `AgentSessionEvent{action:"prompted"}` (HTTP 200 in 5s)   | Re-invoke with the AgentActivity log as history |
| Greptile / Sentry Seer      | PR comment / issue UI / Slack        | Posted finding / "add context" link                 | Webhook on comment / @mention                                     | New pass with full thread                       |

**The dominant pattern is uniform:** post the question where the human already is, show a visible
waiting state, detect the reply by webhook (when a server exists) or polling (when it does not),
and **resume by re-reading the full thread as context** rather than a true process resume. Only
Devin and Claude Code keep a live/disk session; everyone else is stateless-between-turns with the
issue/PR thread serving as the durable session history. That stateless-replay model is the right
fit for DorkOS's fresh-session-per-tick design (the checkpoint is the git commit + the JSONL).

### Linear Agent Sessions (the two-account backend, and its blocker)

Linear has a first-class agent HITL API: `actor=app` agents (own identity, not billable), an
`AgentSession` with an **`awaitingInput`** status, `elicitation` activities that render as question
cards, and an `AgentSessionEvent{action:"prompted"}` webhook when the human replies. Timing
contracts: first `thought` within 10s of session creation, webhook ack HTTP 200 within 5s, activity
heartbeat within 30 minutes or the session goes `stale`.

**The blocker for DorkOS:** Linear delivers all of this via **outbound webhooks**, and DorkOS is
local-first with **no exposed endpoint to receive them**. Without a publicly reachable listener (a
tunnel or the dorkos.ai relay), the Agent Session model is unreachable. The 10s/5s timing contracts
also assume a low-latency receiver. So Linear Agent Accounts are an **optional, deferred,
adapter-confined** upgrade, not the v1 path. v1 must poll.

## Part 3: recommendation for DorkOS (poll-based, tracker-agnostic, identity-mode-aware)

Constraints (from the operator): the question channel must not be tightly coupled to Linear; a
regular account must always work; Linear Agent Accounts (if ever used) are confined to the
`linear-adapter`; and there is no inbound-webhook endpoint, so resume must be **pull**.

**Adopt the stateless-replay variant of pattern 3, with the tracker issue as the durable store:**

1. **Ask.** A stage that hits a genuine `stop-and-ask` posts the **question text as a comment**
   (a readable artifact, not just a label), applies the generic `needs-input` marker
   (`agent/needs-input` on Linear), and stops the tick. The agent's own write carries
   `identity.marker` so its comments are distinguishable from the human's.
2. **Notify (identity-mode dependent).** Whether Linear can notify the human depends on identity mode:
   - **Two-account** (distinct human account): assign/delegate to the human; Linear notifies natively.
   - **Shared or single-account** (the current DorkOS reality, agent acts as the user): `assignToHuman`
     is a no-op and Linear will not notify, so the **primary** attention signal must be **out of band**
     (Telegram / Relay nudge, or the DorkOS chat surface). The Linear comment + label remain the
     durable record; the nudge is promoted from "courtesy" to "primary."
3. **Detect (poll).** A resume tick polls the tracker for `needs-input` items and reads their
   comments. A comment **without** `identity.marker`, posted after the agent's question, **is** the
   answer (the `shouldRespondToComment` rule-3 path; the marker is the disambiguator that makes this
   work even in shared-account mode). No webhook required.
4. **Resume (re-read thread, or `--resume`).** Re-attach the worktree at HEAD and resume: either the
   Claude SDK `--resume <sessionId>` with the answer injected, or (simpler, and what most products do)
   re-run the stage with the full issue + comment thread as context. The thread is the session history.
5. **Clear.** Remove `needs-input`, restore the working stage label, continue the loop.

**Why this satisfies every constraint:** it is pull-only (no exposed endpoint), it is expressed in
generic verbs (`comment`, `needsInput`, `getInbox`, the `needs-input` marker) that any tracker
adapter can fulfil, it works for shared/regular/two-account modes (the marker disambiguates without
needing two identities), and it leaves Linear Agent Accounts as a clean, optional, adapter-confined
upgrade for the day a reachable relay exists.

**The generic vs adapter split:**

- **Generic layer (`@dorkos/flow` + stage skills):** the channel matrix (`liveSession x identityMode
x trigger`), the ask/detect/resume contract, the `needs-input` marker semantics. Never names a
  tracker.
- **`linear-adapter`:** maps the generic verbs onto Linear (comment + label + optional delegate);
  owns the optional `actor=app` Agent Account / AgentSession path and its webhook-vs-poll tradeoff;
  owns native-Triage normalization.

## Sources

Frameworks: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) ·
[Temporal HITL](https://temporal.io/blog/human-in-the-loop-approvals) ·
[OpenAI Agents SDK HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/) ·
[Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions) ·
[Claude Agent SDK user input / defer](https://code.claude.com/docs/en/agent-sdk/user-input) ·
[Deferred Permission Pattern](https://www.agentpatterns.ai/agent-design/deferred-permission-pattern/) ·
[MCP elicitation](https://mcginniscommawill.com/posts/2026-03-25-mcp-sampling-elicitation-guide/)

Products + Linear: [Devin Slack](https://docs.devin.ai/integrations/slack) ·
[Cursor background agents](https://docs.cursor.com/background-agent) ·
[GitHub Copilot coding agent](https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent) ·
[Claude Code agent view](https://code.claude.com/docs/en/agent-view) ·
[Linear agent interaction](https://linear.app/developers/agent-interaction) ·
[Linear agent best practices](https://linear.app/developers/agent-best-practices) ·
[Our approach to the Agent Interaction SDK](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk) ·
[linear-agent-bridge](https://github.com/tokezooo/linear-agent-bridge)
