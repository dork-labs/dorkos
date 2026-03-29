---
title: 'Linear Workflow Automation: Automations, Webhooks, AI Agents, and Closed-Loop Dev Workflows'
date: 2026-03-28
type: external-best-practices
status: active
tags:
  [
    linear,
    automation,
    webhooks,
    ai-agents,
    claude-code,
    sprint-planning,
    triage,
    github-integration,
    mcp,
    workflow,
  ]
searches_performed: 14
sources_count: 32
---

# Linear Workflow Automation: Comprehensive Research

## Research Summary

Linear has evolved from a fast issue tracker into a platform for autonomous development workflows. As of early 2026, it offers a layered automation stack: native built-in automations (status transitions, triage rules, cycle management), first-party integrations (GitHub, Slack, Sentry), a GraphQL API with webhooks, an MCP server for AI tool use, and a formal Agent SDK enabling custom agents to participate as Linear workspace members. Linear's CEO declared "issue tracking is dead" in March 2026, signaling the company's full pivot toward agents as the primary execution layer. Coding agents are already installed in 75% of Linear's enterprise workspaces.

---

## 1. Linear's Automation Stack (Layer by Layer)

### Layer 1: Built-In Native Automations

Linear's native automations are configured per team at **Settings → Teams → Issue statuses & automations**. They are deliberately limited to single-trigger, single-action, same-issue scope — no aggregation, no conditional branching, no cross-issue logic.

**Triage Rules** (Business/Enterprise):

- Triggered when issues enter the Triage state
- Conditions: any filterable issue property (title contains, label is, priority is, etc.)
- Actions: update team, status, assignee, label, project, or priority
- Rules execute top-down in configured order
- On Business/Enterprise, rules can be auto-applied vs. suggestion-only

**Cycle Automations**:

- Auto-add issues to active cycle when they reach a certain state
- Auto-move incomplete issues to the next cycle on cycle end
- Auto-close/archive resolved issues on schedule

**Auto-close and Auto-archive**:

- Close issues not updated within N days
- Archive closed issues after M days
- Creator notified on archive

**Sub-issue automations** (team-level toggles):

- Auto-close parent when all sub-issues complete
- Auto-close sub-issues when parent closes

**GitHub-driven status transitions** (via GitHub integration):

- Branch created with issue ID → move to "In Progress"
- Pull request opened → move to "In Review"
- Pull request merged → move to "Done" (configurable to a different terminal state)

**Limitation identified by practitioners**: Linear's automation rules cannot aggregate across issues, apply multi-step conditional logic, trigger from external events, or analyze patterns. Everything beyond these basics requires the API, webhooks, or third-party automation platforms.

### Layer 2: First-Party Integrations

**GitHub / GitLab**:

- Links issues ↔ branches/commits/PRs by ID in branch name, commit message, or PR body
- Bidirectional status sync: issue state reflects PR lifecycle automatically
- Per-team configuration of which state transitions occur at each PR event
- GitHub Issues can sync bidirectionally (useful for open-source projects)
- GitHub Actions can call Linear's API to create issues on deploy failures, post deployment URLs as comments on issues

**Slack**:

- The `@Linear` agent in Slack creates issues from conversation context (natural language)
- Linear notification bots post issue updates to channels
- Slack Workflow Builder can trigger Linear issue creation from Slack events
- Reverse: Linear issue state changes can post to Slack channels

**Sentry**:

- Automatically creates Linear issues from Sentry error reports (includes stack traces, user context)
- Links existing Linear issues to Sentry exceptions
- Bidirectional: resolving a Linear issue can resolve the Sentry alert

**Intercom / Zendesk / Gong**:

- Trigger AI agent sessions in Linear from support tickets
- Auto-create Linear issues from customer-reported problems

**Linear's full integration surface**: 200+ integrations across GitHub, GitLab, Figma, Slack, Discord, Sentry, Intercom, Zendesk, Notion, Jira, and more.

### Layer 3: Webhooks

Linear webhooks deliver real-time HTTP POST events for all entity mutations.

**Configuration**: Workspace or team-scoped, via Settings UI or GraphQL API. Requires admin permissions.

**Security**: HMAC-SHA256 signature in `Linear-Signature` header. Validate using the webhook secret. Replay prevention via timestamp field.

**HTTP headers on every delivery**:

```
Content-Type: application/json
Linear-Delivery: <uuid>
Linear-Event: <EntityType>
Linear-Signature: <hmac-sha256>
```

**Payload structure**:

```json
{
  "action": "create|update|remove",
  "type": "Issue|Comment|Project|...",
  "createdAt": "ISO-8601",
  "organizationId": "uuid",
  "webhookTimestamp": 1234567890,
  "webhookId": "uuid",
  "actor": { "id": "uuid", "type": "user", "name": "...", "email": "..." },
  "data": {
    /* full entity snapshot */
  },
  "updatedFrom": {
    /* previous values of changed fields only */
  }
}
```

The `updatedFrom` delta pattern is critical for automation: it tells you what changed, not just what the current state is. For example, detecting a state transition from "In Review" to "Done" requires checking `updatedFrom.stateId` against a known state ID.

**Event types available**:

- Issues (create/update/remove)
- Issue Attachments
- Issue Comments
- Issue Labels, Comment Reactions
- Projects, Project Updates
- Documents
- Initiatives, Initiative Updates
- Cycles
- Customers, Customer Requests
- Users
- Issue SLA
- OAuthApp revoked
- **AgentSessionEvent** (created/prompted — for agent workflows)

### Layer 4: GraphQL API

The GraphQL API is Linear's complete integration surface. Everything in the UI is available via API.

**Authentication**: API key (`Authorization: Bearer <key>`) or OAuth 2.0. Rate limits apply.

**Key mutation patterns for automation**:

- `issueCreate` — create issues programmatically (lands in Triage if enabled, default Backlog state otherwise)
- `issueUpdate` — update any field (stateId, assigneeId, priority, labelIds, cycleId, projectId, etc.)
- `issueRelationCreate` — link issues as blocks/blocked/related/duplicate
- `commentCreate` — post agent thoughts or summaries as issue comments
- `agentActivityCreate` — emit activities within an AgentSession (thought/action/response/error)
- `agentSessionUpdate` — update session state or add external URLs

**Key query patterns for automation**:

- `issues(filter: {...})` — query issues with rich filter operators
- `team.cycles` — get active/next/past cycles
- `issueRepositorySuggestions` — LLM-ranked repo suggestions for a given issue
- `viewer` — get the authenticated user/app identity

**Pagination**: Relay-style cursor pagination (`first`, `after`, `last`, `before`) on all list queries.

### Layer 5: MCP Server

**Endpoint**: `https://mcp.linear.app/mcp` (HTTP Streams transport)

**Auth**: OAuth 2.1 with dynamic client registration (interactive) or `Authorization: Bearer <api_key>` (non-interactive, for agents)

**Tools exposed (21+)**:

- Issues: list, get, create, update, list_my_issues, search with filters
- Projects: list, get, create, update, create project updates, create project labels
- Cycles: list, manage, velocity/burndown tracking
- Teams: list, get, team member data
- Users: list, get
- Milestones: create, edit
- Initiatives: create, edit
- Initiative Updates: create, edit
- Comments: add markdown comments to issues
- Documents: create
- Issue Relations: manage dependencies
- Images: load and attach
- Resources: load any Linear resource by URL

**Primary use case**: Enables AI assistants (Claude, Cursor, Windsurf) and autonomous agents to perform issue management as tool calls within their reasoning loops.

### Layer 6: Agent SDK (Developer Preview)

The newest and most powerful layer — first-party support for custom agents as workspace members.

**Authentication**: OAuth2 with `actor=app` parameter. Agents do not count as billable users. Admin scope is NOT compatible with `actor=app`.

**Available OAuth scopes**:
| Scope | Purpose |
|---|---|
| `app:assignable` | Enable issue delegation and project membership |
| `app:mentionable` | Enable mentions across all surfaces |
| `customer:read/write` | Customer data access |
| `initiative:read/write` | Initiative data access |

**Agent capabilities in the workspace**:

- Appear in assignee menus alongside humans
- Be @-mentioned in issues, documents, and editor surfaces
- Receive delegated issues (human retains ownership, agent executes)
- Create and reply to comments
- Participate in projects and documents

**AgentSession lifecycle states**: `pending` → `active` → `awaitingInput` → `complete` / `error` / `stale`

**Webhook events for agents**:

- `AgentSessionEvent` action `created`: fires when agent is mentioned or assigned
- `AgentSessionEvent` action `prompted`: fires when user sends follow-up message

**Critical timing constraints**:

- Webhook receiver must respond within **5 seconds**
- Agent must emit first activity or update external URLs within **10 seconds** of `created` event (or session becomes "unresponsive")

**Activity types** (semantic communication protocol):

- `thought` — internal reasoning visible in the session panel
- `action` — tool invocation with optional parameter and result (can be `ephemeral: true`)
- `elicitation` — request clarification or confirmation from the user
- `response` — final deliverable or completion
- `error` — failure with recovery guidance

**Agent Plans**: Session-level task checklists. Each plan item has status: `pending`, `inProgress`, `completed`, `canceled`. Plans must be replaced in entirety when updated — no partial updates.

**promptContext**: The `created` webhook payload includes a `promptContext` field — a structured XML string containing issue details, comments, parent issues, project context, and workspace-level guidance rules. Agents can use this directly as LLM context.

**Additional Guidance**: Workspace or team-level natural language instructions that agents receive. Supports markdown, version history. Used to encode coding conventions, review processes, repository preferences.

---

## 2. AI-Powered Triage and Prioritization

### Triage Intelligence (Business/Enterprise)

Linear's Triage Intelligence is an agentic LLM system that analyzes incoming issues and produces recommendations.

**Technical approach**: Moved from small models (GPT-4o mini, Gemini 2.0 Flash) to frontier models (GPT-5, Gemini 2.5 Pro). Agentic architecture allows the model to autonomously fetch additional context from Linear's workspace data before making recommendations. This replaced "tightly scoped prompts and rigid workflows."

**What it analyzes**: Issue title, description, historical workspace patterns, existing issues

**Recommendations produced**:

- Duplicate detection (semantic similarity)
- Related issue linking
- Label suggestions
- Assignee suggestions
- Team routing suggestions
- Project assignment suggestions
- Natural language reasoning for each suggestion

**UI transparency features**:

- Hover-activated reasoning explanations
- "Thinking state" indicator with timer
- Thinking panel showing complete decision trace: context sourced, decisions made, how guidance influenced outcomes
- Clear visual distinction between human-set and AI-recommended metadata

**Auto-apply configuration**:

- Per-property opt-in: show suggestion, hide, or auto-apply
- Auto-apply can be scoped to specific values (e.g., auto-apply `bug` label but not `security`)
- Workspace-level or per-team settings
- Sub-teams inherit parent settings with override support

**Timing**: Full triage analysis takes 1–4 minutes per issue (async). Quick suggestions available faster on all plans via the issue composer.

**Duplicate detection specifics**: Semantic matching across titles, descriptions, customer feedback, and support tickets. Links via `IssueRelation` with type `duplicate`.

### Continuous Planning Model

Linear's recommended approach is continuous planning rather than periodic quarterly planning:

1. **Discovery Phase**: Funnel all feature requests/feedback into a central triage queue as they arrive. Use AI to identify patterns across issues and group related requests into candidate projects.

2. **Planning Phase**: Leadership orders candidate projects by customer request volume and revenue impact, assigning priority levels (High/Medium/Low/No Priority).

3. **Execution Phase**: Projects become the interface for daily work. Issues and sub-issues are created underneath active projects. Cycles are used for sprint execution within teams.

**Backlog hygiene**: Linear recommends against keeping large "someday maybe" backlogs. Keep backlogs actionable and prune regularly.

---

## 3. Project / Cycle / Milestone Hierarchy and Structure

### The Full Hierarchy

```
Organization
├── Initiatives (workspace-level portfolio goals / OKRs)
│   ├── Sub-Initiatives (up to 5 levels deep)
│   └── Projects (many-to-many join table)
├── Teams (primary org unit, every issue belongs to one team)
│   ├── WorkflowStates (per-team state machine, 6 categories)
│   ├── Cycles (per-team sprints with burndown history)
│   └── Issues (belong to exactly one team)
│       └── Sub-Issues (recursive, same entity)
└── Projects (cross-team deliverables)
    ├── ProjectMilestones (stage gates within a project)
    ├── ProjectUpdates (health posts: onTrack/atRisk/offTrack)
    └── Issues (at most one project per issue)
```

### When to Use Each Layer

| Layer      | Use for                                 | Timescale                       |
| ---------- | --------------------------------------- | ------------------------------- |
| Initiative | OKR / organizational goal               | Quarter+                        |
| Project    | Specific deliverable with a target date | Weeks–months                    |
| Cycle      | Sprint execution for a team             | 1–4 weeks (2 weeks most common) |
| Milestone  | Stage gate within a project             | Sub-project checkpoints         |
| Issue      | Single unit of work                     | Days                            |
| Sub-Issue  | Decomposed task within an issue         | Hours–days                      |

### Key Cardinality Rules

- Issue → Team: required, N:1
- Issue → Project: optional, N:1 (one project at a time)
- Issue → Cycle: optional, N:1 (one active cycle per team)
- Issue → Parent: optional, N:1 (sub-issues)
- Project → Teams: optional, N:M (cross-team)
- Project → Initiatives: optional, N:M (join table)
- Initiative → Parent: optional, N:1, up to 5 deep

### Sprint Planning Best Practices

- **2-week cycles** are the most common: short enough to stay focused, long enough for meaningful features
- **Capacity formula**: (team size) × (working days) × (hours/day) − (estimated carryover)
- **Velocity reference**: evaluate the last 3 cycles' completed estimates for forecast accuracy
- **Don't overload cycles**: let unfinished items roll over automatically
- **Mix issue types**: balance features, bugs, quality work, and tech debt in each cycle
- **Single owner per issue**: clear accountability, not group ownership

### The Linear Method on Work Structure

From Linear's own method documentation:

- Strategic Initiatives drive direction; reserve capacity for unexpected work
- Projects link daily tasks to strategic objectives
- Issues should be small enough to complete in one review cycle
- Write brief specs emphasizing "why," "what," "how" — not exhaustive requirements
- Use Triage as an inbox, not a backlog: process it regularly

---

## 4. Closed-Loop Development Workflow

### The Ideal Flow: Ideation → Triage → Implementation → Review → Deploy → Feedback

```
Customer Feedback / Slack / Support Ticket / Sentry Error
        ↓  (integration or webhook)
    Linear Triage State
        ↓  (Triage Intelligence: auto-label, assign team, detect duplicates)
    Backlog (Candidate Project or standalone Issue)
        ↓  (Sprint planning: add to active Cycle)
    In Progress (branch created, GitHub integration fires)
        ↓  (AI coding agent assigned: Claude Code / Copilot / Codex)
    In Review (PR opened, GitHub integration fires)
        ↓  (code review, agent posts review as Linear comment)
    Done (PR merged, GitHub integration fires)
        ↓  (optional: deployment webhook → Linear comment with deploy URL)
    Closed / Archived (auto-archive after N days)
        ↓  (feedback loop: Sentry/Intercom link issues back to new issues)
```

### GitHub Integration as the Automation Backbone

The GitHub integration handles the core development lifecycle automatically with zero manual status updates:

1. Developer copies Linear issue branch name (keyboard shortcut: auto-assigns, marks In Progress, copies branch)
2. Creates branch with issue ID embedded (e.g., `eng-123-fix-auth-bug`)
3. Opens draft PR → Linear moves issue to "In Review"
4. PR merged → Linear moves issue to "Done"

**Advanced pattern**: If you have a staging gate before production, configure the GitHub integration to move to "Ready to Deploy" (not "Done") on PR merge. Then use a GitHub Action webhook to call `issueUpdate` and move to "Done" after a successful production deployment.

### The Cotera Pattern: Custom Automation Layer

Cotera's team documented exactly what Linear's built-in automations cannot handle and what custom automation they built on top:

**What Linear cannot do natively**:

- Aggregate across multiple issues
- Apply conditional logic beyond basic field matching
- Analyze historical patterns for triage
- Generate summaries or narrative reports

**What they built as custom agents**:

1. **Triage Agent**: Reads new issues, suggests priority/team/labels/cycle. Uses historical patterns. Responds in ~30 seconds via comment. Result: triage time dropped from 3 min to 45 seconds per issue.
2. **Cross-Project Status Agent**: Morning summary across multi-team projects, posts to Slack. Identified blockers and velocity mismatches. Saved ~40 min/week.
3. **Duplicate Detector**: Scans new issues against recently closed ones by semantic similarity. ~70% precision. Links as `duplicate` relation.
4. **Sprint Status Reporter**: Pulls cycle data, generates narrative for leadership. Saved ~25 min/week.

**Deliberately NOT automated**: sprint planning, estimation, retrospectives — collaborative discussion provides value that goes beyond task assignment.

### The Continue.dev Pattern: Slack → GitHub → Linear Loop

Continue.dev built a Slack-driven closed-loop system:

1. Developer tags `@Continue` in Slack with a bug report
2. Cloud agent reads the Slack thread for reproduction steps
3. Agent connects to GitHub, locates relevant files via semantic search
4. Agent creates a branch, implements a fix, opens a PR
5. Linear issue is created or updated automatically (via MCP tool calls)

This is the "programmable codebase" pattern: Slack is the control plane, GitHub is the execution layer, Linear is the state management layer.

---

## 5. AI Agent Integration Patterns

### Pattern A: MCP-Driven Session Management (Damian Galarza Pattern)

Fully autonomous bash-loop agent using Linear's MCP tools:

```
while true:
  1. Query Linear MCP: get highest-priority "Todo" issue
  2. If none in Todo, check Backlog
  3. Create feature branch
  4. Implement feature (Claude Code)
  5. Run tests and linters
  6. Spawn sub-agent reviewers: evaluate diff vs. acceptance criteria
  7. Post review feedback as Linear comments
  8. Address review feedback
  9. Commit, open PR
  10. Update Linear MCP: move issue to "Done"
  11. Update PROGRESS.md (agent memory across iterations)
  12. Checkout main, rebase for next iteration
```

**Key design principles**:

- Fresh context window per issue (bash loop, not a single long session)
- Well-specified issues with clear acceptance criteria
- Automated verification (tests/linters) as exit criterion
- Linear as the single source of truth for full lifecycle visibility

**Performance reported**: 38 issues closed in 3 weeks with near-zero intervention.

### Pattern B: Label-Driven Agent Triggers (Cyrus Pattern)

Labels as a state machine for agent routing:

```json
// ~/.cyrus/config.json
{
  "triggers": {
    "bug": "debugger-mode",
    "feature": "builder-mode",
    "performance": "optimization-mode"
  }
}
```

When an issue is assigned to the Cyrus agent with a `bug` label, the agent receives a specialized system prompt for error analysis + Sentry MCP integration for stack traces. When labeled `feature`, it gets a builder prompt that decomposes into sub-tasks.

**Performance reported**: 38 issues resolved in 3 weeks, 87% first-attempt success rate, 147 hours saved.

### Pattern C: Native Linear Agent (Agent SDK Pattern)

Building a first-class Linear agent using the Agent SDK:

1. Create an OAuth app with `actor=app` + `app:assignable` + `app:mentionable` scopes
2. Register webhook endpoint for `AgentSessionEvent`
3. When `created` event arrives (issue delegated or @mentioned):
   - Respond to webhook within **5 seconds**
   - Emit a `thought` activity within **10 seconds** to acknowledge
   - Parse `promptContext` XML for issue details, comments, project context, and guidance
4. Execute work loop:
   - Emit `action` activities for each tool call (can be ephemeral)
   - Create an Agent Plan with sub-tasks
   - Update plan items as work progresses
5. Post `response` activity when complete, or `error` with recovery link on failure
6. Optionally add `externalUrls` to session for links to PR, CI dashboard, etc.

**Reference implementation**: [Linear Weather Bot](https://github.com/linear/weather-bot) — TypeScript SDK + Cloudflare Workers

### Pattern D: Huginn — Full Coding Agent Architecture (daily.dev Pattern)

Production lessons from building a coding agent on Linear:

**State machine via labels** (not plan field — plan gets wiped on thread archive):

- `huginn:idle` → `huginn:planning` → `huginn:approved` → `huginn:executing`
- Sub-stage labels: `huginn:stage:workspace-setup`, `huginn:stage:implementation`

**Output parsing**: Three-tier fallback: MCP tool calls → text parsing (regex, ~80% reliable) → accumulated output. The repo name parser alone handles markdown escaping, trailing punctuation, path prefixes, unicode artifacts.

**Provider abstraction**: `AgentRunner` interface to abstract Claude Code from Codex. One new class = new provider.

**Session management pitfall**: Claude Code uses CWD as part of session lookup key. Always execute from workspace root; route per-repo operations through prompts, not CWD changes.

**Testing**: Build "Digital Twin Universe" — in-memory behavioral replicas of all external dependencies (Linear GraphQL API, GitHub, KMS). Tests use real SDKs against fake backends.

**What agents handle well**: Well-defined single-repo tasks with clear acceptance criteria, test-driven feedback loops, incremental changes.

**What agents struggle with**: Hour-long exploratory sessions, large multi-file refactors requiring architectural judgment, nuanced design decisions.

---

## 6. Linear's Broader Vision: "Issue Tracking is Dead"

Linear CEO Karri Saarinen declared in March 2026 that traditional issue tracking is being superseded. The new model:

- **Issues become context containers**: agents read them for requirements, post progress updates, and close them autonomously
- **Linear as coordination layer**: humans define what matters (priorities, projects, initiatives); agents execute
- **75% of enterprise workspaces** already have coding agents installed
- **5× increase** in agent workload volume over 3 months

**Current capabilities** (as of March 2026):

- Chat interface for natural language commands in Linear
- Issue creation from discussion context
- Multi-platform integration (Slack, Teams, Zendesk)
- Skills and Automations (Business/Enterprise): reusable workflow sequences with automated triggers

**Planned features**: Coding agent for writing/debugging code, codebase Q&A, code diff presentation.

**Pricing**: Currently unchanged during beta. Usage-based pricing for automation and coding features coming beyond specified thresholds.

**Security caveat** (from The Register): Prompt injection risks from malicious inputs not yet addressed in documentation.

---

## 7. Third-Party Automation Platforms

For teams that need more sophisticated automation without building custom agents:

| Platform        | Best For                                             | Linear Integration                   |
| --------------- | ---------------------------------------------------- | ------------------------------------ |
| **n8n**         | Self-hosted, code-friendly, complex multi-step flows | Native Linear node + webhook trigger |
| **Zapier**      | Quick no-code automations, broad app library         | 30+ pre-built Linear Zaps            |
| **Make**        | Visual complex workflows, power users                | Native Linear integration            |
| **Pipedream**   | Developer-focused, code steps allowed                | Linear event sources                 |
| **Trigger.dev** | Code-first background jobs in TypeScript             | Works via Linear webhooks + API      |

**Common Zapier/n8n patterns for Linear**:

- Form submission → Linear issue (customer feedback intake)
- Email → Linear issue (support request capture)
- Recurring schedule → Linear issue (repeating tasks)
- Linear issue created → Slack notification
- Linear issue completed → update external spreadsheet/CRM
- GitHub Actions deploy success → Linear issue comment with deploy URL

---

## Key Takeaways for DorkOS

1. **Linear's MCP server** (`https://mcp.linear.app/mcp`) is the fastest path to letting DorkOS agents interact with Linear — no setup, OAuth or API key, 21+ tools. See existing research `20260328_linear_mcp_server.md`.

2. **The Agent SDK** is the right layer for building a first-class DorkOS ↔ Linear integration where DorkOS agents appear as Linear workspace members, receive issue delegations, and post structured progress updates.

3. **Webhooks as the trigger layer**: Subscribe to `AgentSessionEvent` for agent-driven flows, `Issue` events for reactive automation, `IssueComment` for human feedback loops.

4. **Well-specified issues are the prerequisite**: All successful agent patterns (Damian Galarza, Huginn, Cyrus) report that issue quality — clear title, acceptance criteria, bounded scope — is the single biggest driver of agent success rate.

5. **Label-based state machines** are more robust than plan fields for tracking agent execution state across crashes/restarts (plan field gets wiped on thread archive).

6. **The hierarchy for DorkOS use**: Initiatives = product areas/OKRs, Projects = features/milestones, Cycles = sprint execution, Issues = agent work items, Sub-Issues = agent decomposition of complex tasks.

7. **Triage Intelligence + custom automation** complement each other: Linear's AI handles incoming issue classification; custom webhook-driven agents handle execution and lifecycle management.

---

## Sources & Evidence

- [Linear AI Workflows page](https://linear.app/ai)
- [Linear Agents Developer Docs](https://linear.app/developers/agents)
- [Agent Interaction Developer Guide](https://linear.app/developers/agent-interaction)
- [AI Agents – Linear Docs](https://linear.app/docs/agents-in-linear)
- [Linear Automations Integrations Directory](https://linear.app/integrations/automations)
- [Linear GitHub Integration Docs](https://linear.app/docs/github-integration)
- [Linear GitHub Integration page](https://linear.app/integrations/github)
- [Linear Webhooks Developer Docs](https://linear.app/developers/webhooks)
- [API and Webhooks – Linear Docs](https://linear.app/docs/api-and-webhooks)
- [Linear Triage Docs](https://linear.app/docs/triage)
- [How we built Triage Intelligence – Linear](https://linear.app/now/how-we-built-triage-intelligence)
- [Continuous planning in Linear – Linear](https://linear.app/now/continuous-planning-in-linear)
- [Our approach to building the Agent Interaction SDK – Linear](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)
- [Linear Method: Principles & Practices](https://linear.app/method/introduction)
- [Project milestones – Linear Docs](https://linear.app/docs/project-milestones)
- [Linear adopts agentic AI – The Register (March 2026)](https://www.theregister.com/2026/03/26/linear_agent/)
- [Building a Linear-Driven Agent Loop with Claude Code – Damian Galarza (Feb 2026)](https://www.damiangalarza.com/posts/2026-02-13-linear-agent-loop/)
- [Agentic Claude Code Workflow with Linear Integration – Hypeflo.ws](https://www.hypeflo.ws/workflow/agentic-claude-code-workflow-with-linear-integration)
- [Linear + Claude Code: 20x faster shipping – Cyrus](https://www.atcyrus.com/stories/linear-claude-code-integration-guide)
- [How we built a Linear coding agent: the hard parts – daily.dev (Huginn)](https://daily.dev/blog/how-we-built-a-linear-coding-agent-the-hard-parts)
- [Bug Reports Should Fix Themselves: Slack + GitHub + Linear – Continue.dev](https://blog.continue.dev/slack-cloud-agent-github-linear)
- [Linear's Built-In Automations Aren't Enough – Cotera](https://cotera.co/articles/linear-automation-guide)
- [Linear agent for Slack – Changelog](https://linear.app/changelog/2025-10-23-linear-agent-for-slack)
- [How to Build Linear Agents with Hookdeck CLI](https://hookdeck.com/webhooks/platforms/how-to-build-linear-agents-with-hookdeck-cli)
- [Building Linear Agents in Node.js & Rivet – Rivet](https://rivet.dev/blog/2025-05-28-building-linear-agents-in-node-js-and-rivet-full-walkthrough-and-starter-kit/)
- [5 ways to automate Linear – Zapier](https://zapier.com/blog/automate-linear/)
- [Linear Webhooks: Complete Guide with Payload Examples – InventiveHQ](https://inventivehq.com/blog/linear-webhooks-guide)
- [Linear Guide: Setup, Best Practices & Pro Tips – Morgen](https://www.morgen.so/blog-posts/linear-project-management)
- [How to set up Linear MCP in Claude Code – Composio](https://composio.dev/content/how-to-set-up-linear-mcp-in-claude-code-to-automate-issue-tracking)
- [Linear Review 2025 – DevToolScout](https://www.devtoolscout.com/reviews/linear-review-2025-lightning-fast-issue-tracking-built-for-modern-development-teams)
- [Linear Sentry Integration](https://linear.app/integrations/sentry)
- [Linear Claude Integration](https://linear.app/integrations/claude)
- [Linear Agents Integrations directory](https://linear.app/integrations/agents)

---

## Research Gaps & Limitations

1. **Full Agent SDK API surface**: The `issueRepositorySuggestions` query and Signals documentation are referenced but not fully detailed in public docs.
2. **Skills and Automations feature**: Referenced as a Business/Enterprise feature in the March 2026 article but no detailed documentation found — may still be in private beta.
3. **Triage Intelligence complete configuration surface**: The auto-apply scoping (per-value configuration) is documented at a high level; the exact UI and API fields are not confirmed.
4. **Agent SDK GA timeline**: Still Developer Preview with no GA date announced as of March 2026. API may change.
5. **Usage-based pricing thresholds**: Mentioned as "coming" for agent/automation features but not specified.
6. **Prompt injection security**: The Register flagged this as an unaddressed risk; no official guidance from Linear on mitigations.

---

## Search Methodology

- Searches performed: 14
- Most productive queries: "Linear Claude Code AI agent integration 2025 2026", "Linear built-in automations rules workflow", "Linear agents API developer preview AgentSession"
- Most productive source types: Linear official docs/changelog, practitioner blog posts (Damian Galarza, daily.dev/Huginn, Cotera, Continue.dev, Cyrus)
- Existing research used as foundation: `20260218_linear-domain-model.md`, `20260328_linear_mcp_server.md`
