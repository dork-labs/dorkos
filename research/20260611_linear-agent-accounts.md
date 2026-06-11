# Linear Agent Accounts — What They Are and What They Mean for Linear Loop + the Orchestration Extension

**Date:** 2026-06-11
**Mode:** Web research (official Linear developer docs, changelogs, production implementer write-ups)
**Question:** What are Linear "Agent Accounts," how do they work, and should the linear-loop or the Symphony-style orchestration extension adopt them?
**Adoption stance:** **Deferred** — facts recorded here; no commitment yet. The extension's design (DOR-89) should keep both paths (polling + label claims vs. Agent Sessions + delegation) open until this is decided.
**Related:** `research/20260611_work-sequencing-linear-method.md` (claiming contract, dispatch policy), DOR-88/89/90 (Orchestration Extension project).

---

## 1. What an Agent Account is

A **free, non-billable app user** created when an OAuth application installs with the `actor=app` parameter (workspace-admin approval required). It appears in the workspace like a member — own name/avatar, dedicated profile/activity page, @-mentionable, delegable — but cannot sign in to the Linear app and cannot hold the `admin` scope. Opt-in scopes: `app:assignable` (appears in delegation menus), `app:mentionable`. Multiple distinct agents can coexist per workspace; agents never consume billable seats. Rate limit: 5,000 req/hr per app user (2× a personal API key).

Shipping Linear agents today: OpenAI Codex, Cursor, GitHub Copilot, Devin, Sentry Seer, Factory, Charlie, Oz (Warp), ChatPRD, Tembo, Ranger.

## 2. The Agent Session API

**AgentSession** — the container for one agent interaction. Auto-created when an issue is **delegated** to the agent or the agent is **@-mentioned**; can also be created proactively (`agentSessionCreateOnIssue` / `agentSessionCreateOnComment`). Six states, managed by Linear from the last activity: `pending` → `active` → (`awaitingInput` | `error` | `complete`), plus `stale` after 30 idle minutes (recoverable by emitting any activity).

**AgentActivity** — five server-validated types:

| Type          | Purpose                                 | Notes                                     |
| ------------- | --------------------------------------- | ----------------------------------------- |
| `thought`     | Progress/reasoning                      | Ephemeral — replaced by the next activity |
| `action`      | Tool invocation (`parameter`, `result`) | Ephemeral                                 |
| `elicitation` | Ask the human a question                | Drives session to `awaitingInput`         |
| `response`    | Final result (Markdown)                 | Terminal → `complete`                     |
| `error`       | Failure                                 | Terminal → `error`                        |

A `prompt` activity is **user-generated only** — it arrives via webhook when a human replies in-session. `agentSessionUpdate` accepts a `plan` (steps with `pending/inProgress/completed/canceled`; full replacement on every update) rendered as a native checklist, and `externalUrls` (`{label, url}[]`) for PRs/dashboards/evidence links.

## 3. Interaction model and timing contract

- **Triggers**: delegation (UI or `issueUpdate`) and @-mention both fire an `AgentSessionEvent` webhook (`action: created`) carrying `promptContext` — issue title/description/comments/guidance as structured XML. Human follow-ups arrive as `action: prompted`; **Stop** arrives as `prompted` with `agentActivity.signal: "stop"`.
- **Agent Interaction Guidelines (AIG)** timing: webhook endpoint must return HTTP 200 **within 5s**; the agent must emit its first activity **within 10s** of `created` or be marked unresponsive; sessions go `stale` after **30 min** without activity. Real work must be async.
- **Known hazard**: Linear sends duplicate events (AgentSession + Comment) within ~5s of the same delegation — implementers must dedupe on session ID.
- **The assignee/delegate split**: assignees are **always humans**; agents occupy a separate **`Issue.delegate`** field. Delegation = the native claim primitive.

## 4. Capability delta vs. a plain OAuth user token

Agent accounts add: own workspace identity, delegate-field targeting, AgentSession/AgentActivity/plan APIs, elicitation flow, session webhooks, non-billable seat. They lose: app sign-in, `admin` scope. Everything else (issues, comments, attachments, state transitions) is equivalent.

## 5. Implications for our two systems

### linear-loop (`/pm`) — no change today

Agent Accounts require hosting an OAuth app with a publicly reachable webhook endpoint and the 5s/10s timing contract. An interactive CLI session can't hold that contract; `/pm` keeps acting through the operator's token with the Agent Action comment convention as its voice.

### Orchestration extension — three deltas, contingent on adoption

If adopted, Agent Accounts would amend the recorded DOR-89 deltas:

1. **Claiming**: delegation to the agent _is_ the claim — auto-creates the session, fires the webhook, shows agent identity in the UI. The `agent/claimed` label becomes redundant; `agent/ready` remains the dispatch gate. (Our assignee-stays-human convention is exactly Linear's own model — the delegate field is the native version of what our labels work around.)
2. **Dispatch**: webhook-driven (`created` event → launch worker in its workspace) instead of poll-driven. A slow reconciliation poll stays regardless (Symphony's pattern; also: un-delegation behavior is undocumented, and the duplicate-webhook hazard needs defensive dedup).
3. **Conventions map 1:1**: `elicitation` = our needs-input protocol (native UI, in-thread human reply); `response` = the completion comment; `plan` = task checklist; stop signal = the cancellation primitive Symphony lacks; `externalUrls` + response Markdown = where verification evidence (DOR-95) attaches.

### The local-webhook problem (the real adoption cost)

Linear webhooks POST to a public HTTPS URL; a local-first DorkOS server (`localhost:4242`) is unreachable. Options:

| Option                       | How                                                                                                                                | Trade-offs                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tunnel                       | cloudflared named tunnel / Tailscale Funnel / ngrok                                                                                | Easy; per-operator setup; another always-on process; URL stability varies                                                                                                                                 |
| Cloud relay via dorkos.ai    | `apps/site` receives webhooks at a stable URL → local server retrieves over an **outbound** connection (poll or persistent stream) | No operator setup; works behind NAT; adds a hosted component + queue semantics; Vercel serverless makes persistent push connections awkward — short-interval polling of our own endpoint is the simple v1 |
| Keep polling Linear directly | Symphony's model; 30s tick is well inside the 5k req/hr budget                                                                     | Simplest; no new infrastructure; loses sub-second dispatch and — critically — **cannot meet the AIG 10-second acknowledgment**, so Agent Sessions are effectively off the table while polling             |

**Key interaction**: the AIG timing contract makes Agent Accounts practical _only_ with a reachable webhook path. Deferring Agent Accounts ⇒ polling remains the v1 dispatch mechanism, and the tunnel/relay question moves into the Agent Account evaluation rather than blocking v1.

## 6. Open questions (for the eventual decision)

- Exact GraphQL field for programmatic delegation (`delegateId`? `delegatee`?) — verify against the live schema.
- Un-delegation semantics (agent removed without Stop) — undocumented; needs defensive reconciliation either way.
- Platform maturity: the agents API + SDK are Developer Preview / "living document" — breaking changes possible before GA.
- Whether `/pm`-created work should be _delegated_ to the DorkOS agent (one workspace identity for all autonomous work) or whether multiple DorkOS-hosted runtimes warrant multiple agent identities.

## 7. Sources

- linear.app/developers/agents · linear.app/developers/agent-interaction · linear.app/developers/agent-best-practices · linear.app/developers/rate-limiting
- linear.app/docs/agents-in-linear · linear.app/docs/assigning-issues · linear.app/agents
- Changelogs: 2025-05-20 "Linear for Agents", 2025-07-30 "Agent Interaction Guidelines and SDK", 2026-03-24 "Introducing Linear Agent"
- linear.app/now/our-approach-to-building-the-agent-interaction-sdk
- Production write-ups: hookdeck.com (webhook guide), github.com/tokezooo/linear-agent-bridge (dedup hazard, stop signal), daily.dev "How we built a Linear coding agent — the hard parts", rivet.dev walkthrough, github.com/linear/linear-agent-demo (official, archived)
