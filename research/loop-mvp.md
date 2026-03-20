---
title: 'Loop MVP: The Autonomous Improvement Engine (v0.4)'
date: 2026-02-18
type: exploratory
status: superseded
superseded_by: research/loop-litepaper.md
tags: [loop, autonomous-improvement, mvp, ideation, agent-orchestration]
---

# Loop MVP: The Autonomous Improvement Engine

**Version:** 0.4 (MVP Scope)
**Author:** Dorian Collier
**Date:** February 2026

---

## One-Liner

An open-source data layer and prompt engine that collects signals, organizes work into issues, and tells AI agents exactly what to do next — closing the feedback loop that turns software teams into self-improving systems.

---

## Loop Has No AI

Loop is not an AI product. It's a **fully deterministic data product with a prompt layer.**

There are zero LLM calls inside Loop. No embeddings. No inference. No token costs. No model dependencies. Loop is a web app with a database, a REST API, and a set of human-authored prompt templates. When an agent asks "what should I work on next?", Loop returns the highest-priority unblocked issue along with a hydrated prompt that tells the agent exactly what to do. The agent executes, reports back via Loop's API, and the cycle continues.

**This is the key insight: Loop automatically improves every time a new state-of-the-art AI model is released — without changing a single line of code.**

The quality of Loop's output is a function of two things:

1. **The prompts** — human-authored, stored in Loop, continuously improved by agent feedback
2. **The model reading them** — owned and operated by the user, outside of Loop

When Claude Opus 5 ships, every Loop installation worldwide gets better overnight. When a team switches from Sonnet to Opus, their loop quality improves instantly. Loop doesn't care which model reads its prompts. It doesn't care which agent platform executes the work. It's a protocol, not a runtime.

### Why This Matters

**For users:**

- Run Loop fully on-premises with any model you choose — local LLMs, Claude, GPT, Gemini
- No AI vendor lock-in. Swap models without touching Loop
- No AI costs from Loop itself. Your only costs are the models you already pay for
- No data leaves your infrastructure for AI processing (Loop stores data, agents process it locally)

**For the product:**

- No model fine-tuning to maintain. No prompt engineering regressions from API changes
- No AI-specific infrastructure (GPU instances, embedding databases, vector stores)
- The entire system is deterministic and testable with unit tests
- Deployment is a standard web app: Node.js, Postgres, static React frontend

**For the ecosystem:**

- Any agent that can make HTTP calls works with Loop — DorkOS, Devin, Codex, Claude Code, custom agents
- Any model works — the prompts are model-agnostic instructions
- Open source means the prompt templates are community-improvable
- The protocol (REST API + prompt response) is simple enough that competitors can implement compatible clients

**Analogy:** Loop is a gym. It doesn't do the lifting — it organizes the workout, tracks progress, and tells you what exercise to do next. As the athletes (AI models) get stronger, the results improve without the gym changing. And the workout plans (prompt templates) can be refined independently of both the gym and the athletes.

---

## The Architecture: Pull, Don't Push

The litepaper v2 had Loop dispatching work to DorkOS (push model). The MVP inverts this.

**Push model (v2, complex):**

```
Signal → Loop creates issue → Loop sends to DorkOS → DorkOS runs agent → Agent reports back
```

**Pull model (MVP, simple):**

```
Signal → Loop creates issue → DorkOS polls Loop on schedule → Loop returns issue + prompt → DorkOS runs agent → Agent reports results to Loop API
```

Loop never needs to know how to talk to DorkOS. DorkOS never needs to expose an endpoint. The integration is a single DorkOS Pulse schedule that polls Loop's `/api/dispatch/next` endpoint.

### How It Works with DorkOS Pulse

DorkOS Pulse (already built) runs a cron schedule. The schedule's prompt tells the agent:

```
Check Loop for the next available work item.

1. Call GET https://loop.example.com/api/dispatch/next
   with header Authorization: Bearer {TORQ_API_KEY}

2. If the response contains an issue, follow the instructions
   in the "prompt" field exactly.

3. If the response is empty (no work available), do nothing.
```

Every 5 minutes (configurable), DorkOS checks if there's work. If yes, it runs the returned prompt. If no, it sleeps. The loop runs itself.

### The Dispatch Response

`GET /api/dispatch/next` returns the highest-priority unblocked issue with a fully hydrated prompt:

```json
{
  "issue": {
    "id": "uuid",
    "number": 42,
    "title": "Add loading spinner to OAuth redirect page",
    "type": "task",
    "priority": 2,
    "status": "in_progress",
    "project": {
      "name": "Improve onboarding",
      "goal": "Increase sign-up conversion to 4% (currently 3.2%)"
    },
    "parent": {
      "number": 38,
      "title": "Fix OAuth redirect friction",
      "type": "plan"
    },
    "blockedBy": [],
    "blocking": [45],
    "previousSessions": []
  },
  "prompt": "<fully hydrated prompt — see Prompt System section>",
  "meta": {
    "templateSlug": "task-execute",
    "templateId": "uuid",
    "versionId": "uuid",
    "versionNumber": 5,
    "reviewUrl": "POST /api/prompt-reviews"
  }
}
```

The `meta` block gives agents everything they need to review the prompt after completing work (see Prompt Improvement Loop).

### Priority Logic (Deterministic)

`/api/dispatch/next` selects the next issue using pure scoring:

1. Filter to `status = todo` only
2. Exclude issues where any `blocked_by` relation points to an incomplete issue
3. Score remaining issues:
   - Priority weight: urgent=100, high=75, medium=50, low=25, none=10
   - Goal alignment bonus: +20 if issue's project has an active goal
   - Age bonus: +1 per day in `todo` status (prevents starvation)
   - Type ordering: signal triage > hypothesis > plan > task > monitor (loop progression)
4. Return highest-scoring issue
5. Atomically set status to `in_progress` (prevents double-dispatch)

This is ~30 lines of SQL. Fully testable, no AI.

---

## Domain Model (MVP)

Ten entities. No teams, no cycles, no initiatives, no workflow states as separate entities, no customers.

### Issue

The atomic unit. Everything is an issue.

```
Issue {
  id:              UUID
  number:          Int             // Auto-increment, immutable
  title:           String
  description:     Text            // Markdown
  type:            signal | hypothesis | plan | task | monitor
  status:          triage | backlog | todo | in_progress | done | canceled
  priority:        Int             // 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low

  // Hierarchy (1 level deep — see constraint below)
  parentId:        UUID?           // Parent issue
  projectId:       UUID?           // At most one project

  // Labels (many-to-many via join table)
  // labels: via IssueLabel join

  // Signal metadata (when type = signal)
  signalSource:    String?         // "posthog", "github", "sentry", "feedback", "manual"
  signalPayload:   JSONB?          // Raw signal data

  // Hypothesis metadata (when type = hypothesis)
  hypothesis:      JSONB?          // { statement, confidence, evidence, validationCriteria, prediction }

  // Agent execution results
  agentSessionId:  String?         // External session ID (e.g., DorkOS session)
  agentSummary:    Text?           // What the agent reported
  commits:         JSONB?          // [{ sha, message, url }]
  pullRequests:    JSONB?          // [{ number, url, status, merged }]

  createdAt:       DateTime
  updatedAt:       DateTime
  completedAt:     DateTime?
}
```

**Hierarchy constraint: 1 level deep.** An issue with a `parentId` cannot itself be a parent. The API rejects `POST /api/issues` with a `parentId` that points to an issue that already has a `parentId`. This keeps the data model flat and predictable:

```
✅ Signal #31
   ├── Hypothesis #35 (parentId → #31)
   ├── Task #42 (parentId → #31)
   └── Monitor #46 (parentId → #31)

❌ Signal #31
   └── Hypothesis #35 (parentId → #31)
       └── Task #42 (parentId → #35)  ← REJECTED: #35 already has a parent
```

This means every issue is either a **root issue** (no parent) or a **child issue** (has parent, cannot have children). The loop chain (signal → hypothesis → tasks) is expressed as siblings under a common parent, not as a deep tree. Relations (`blocks`/`blocked_by`) handle execution ordering between siblings.

**Why 1 level?**

- Agents don't need to reason about deep hierarchies — they need a flat list of work
- The dispatch endpoint is simpler (no recursive queries)
- The dashboard is simpler (parent + children, never grandchildren)
- Deep nesting encourages over-planning; flat + relations encourages doing

### Project

Groups issues toward a goal. Supports multiple projects from day 1.

```
Project {
  id:              UUID
  name:            String
  description:     Text?           // Markdown — the project brief
  status:          backlog | planned | active | paused | completed | canceled
  health:          on_track | at_risk | off_track
  goalId:          UUID?           // Primary goal for this project

  createdAt:       DateTime
  updatedAt:       DateTime
}
```

### Goal

A measurable success indicator. Goals give the system (and agents) strategic direction.

```
Goal {
  id:              UUID
  title:           String          // "Increase sign-up conversion to 4%"
  description:     Text?
  metric:          String?         // "signup_conversion_rate"
  targetValue:     Float?          // 4.0
  currentValue:    Float?          // 3.2 (updated by signals or manually)
  unit:            String?         // "%", "ms", "count", etc.
  status:          active | achieved | abandoned
  projectId:       UUID?           // Optional link to a project

  createdAt:       DateTime
  updatedAt:       DateTime
}
```

Goals answer the question: "Is what we're doing actually working?" Without goals, the loop optimizes locally (fix the latest bug). With goals, agents have context for prioritization.

### IssueRelation

Directional links between issues. Critical for execution ordering.

```
IssueRelation {
  id:              UUID
  type:            blocks | blocked_by | related | duplicate
  issueId:         UUID            // Source
  relatedIssueId:  UUID            // Target
  createdAt:       DateTime
}
```

The dispatch endpoint respects `blocks`/`blocked_by` — blocked issues are never dispatched. `duplicate` feeds into signal deduplication. `related` provides context.

### Label

Flat labels for categorization. Distinguishes bugs from features, signals from hypotheses, etc.

```
Label {
  id:              UUID
  name:            String          // "bug", "feature", "infrastructure", "auto-generated"
  color:           String          // Hex color
  createdAt:       DateTime
}
```

Join table `IssueLabel { issueId, labelId }` for many-to-many.

Some labels are system-managed: `auto-generated` (created by the loop), `auto-merged` (PR merged automatically), `needs-human-review` (agent flagged uncertainty).

### Comment

Threaded comments on issues. Agents and humans both use these.

```
Comment {
  id:              UUID
  body:            Text            // Markdown
  issueId:         UUID
  authorName:      String          // "Dorian", "DorkOS Agent", etc.
  authorType:      human | agent
  parentId:        UUID?           // Threaded replies
  createdAt:       DateTime
}
```

### Signal

Raw incoming data. Every signal creates a triage issue.

```
Signal {
  id:              UUID
  source:          String          // "posthog", "github", "sentry", "feedback", "manual"
  sourceId:        String?         // External reference
  type:            String          // "metric-change", "error-spike", "user-feedback", etc.
  severity:        low | medium | high | critical
  payload:         JSONB           // Raw signal data
  issueId:         UUID            // The triage issue created for this signal
  createdAt:       DateTime
}
```

### Entity Relationship Summary

```
Project (N)
  ├── Goal (1, optional)
  └── Issues (N)                [Issue.projectId FK]

Issue (N)
  ├── Children (N)              [parentId → Issue.id, 1 level deep only]
  ├── Comments (N)              [threaded]
  ├── Labels (N:M)              [via IssueLabel join]
  └── IssueRelations (N)        [blocks/blocked_by/related/duplicate]

PromptTemplate (N)
  └── PromptVersions (N)        [versioned content]
       └── PromptReviews (N)    [agent/human feedback]

Goal (N)
  └── linked to Project (optional)

Signal (N)
  └── linked to Issue (1:1)
```

**Key cardinalities:**

| Relationship              | Cardinality                 |
| ------------------------- | --------------------------- |
| Issue → Project           | N:1 (optional)              |
| Issue → Parent Issue      | N:1 (optional, 1 level max) |
| Issue → Labels            | N:M                         |
| Issue → IssueRelations    | 1:N                         |
| Issue → Comments          | 1:N                         |
| Project → Goal            | 1:1 (optional)              |
| Signal → Issue            | 1:1                         |
| PromptTemplate → Versions | 1:N                         |
| PromptVersion → Reviews   | 1:N                         |
| PromptTemplate → Project  | N:1 (optional)              |

---

## The Prompt System

The prompt system is the core of Loop's value. It has two parts: **selecting the right template** based on system state, and **hydrating it** with issue data to produce a complete instruction set for the agent.

### Prompt Selection (Conditions-Based)

Each template has `conditions` — a set of attribute filters. Selection uses cascading specificity (like CSS):

```
PromptTemplate {
  id:              UUID
  slug:            String          // "posthog-metric-triage", "sentry-error-triage"
  name:            String
  description:     String?         // What this template is for

  // Selection
  conditions:      JSONB           // { "type": "signal", "signalSource": "posthog" }
  specificity:     Int             // Higher = more specific, wins ties
  projectId:       UUID?           // Project-scoped override

  // Current version
  activeVersionId: UUID            // Points to the active PromptVersion

  createdAt:       DateTime
  updatedAt:       DateTime
}
```

**Selection algorithm** (deterministic, ~20 lines):

1. Build context object from the issue: `{ type, signalSource, labels[], project, hasFailedSessions, hypothesisConfidence, ... }`
2. Find all templates where every condition key matches the context
3. Sort by: project-specific first, then by specificity descending
4. First match wins
5. If no match, fall back to the default template for the issue's `type`

**Example template conditions:**

| Template                | Conditions                                        | Specificity |
| ----------------------- | ------------------------------------------------- | ----------- |
| `signal-triage`         | `{ "type": "signal" }`                            | 10          |
| `posthog-metric-triage` | `{ "type": "signal", "signalSource": "posthog" }` | 20          |
| `sentry-error-triage`   | `{ "type": "signal", "signalSource": "sentry" }`  | 20          |
| `task-execute`          | `{ "type": "task" }`                              | 10          |
| `task-execute-retry`    | `{ "type": "task", "hasFailedSessions": true }`   | 20          |
| `task-execute-frontend` | `{ "type": "task", "labels": ["frontend"] }`      | 15          |

A PostHog signal matches both `signal-triage` (specificity 10) and `posthog-metric-triage` (specificity 20). The more specific one wins. A task that previously failed matches `task-execute-retry` (specificity 20) over `task-execute` (specificity 10), so the agent gets instructions that include what went wrong last time.

### Prompt Hydration (Dynamic State Injection)

The selected template is a Handlebars template that gets hydrated with the full system state. The template itself handles dynamic conditions:

```handlebars
You are working on issue #{{issue.number}}:
{{issue.title}}

{{#if previousSessions}}
  ## ⚠️ Previous Attempts This issue has been attempted
  {{previousSessions.length}}
  time(s) before:
  {{#each previousSessions}}
    - Attempt
    {{@index}}:
    {{this.status}}
    —
    {{this.agentSummary}}
  {{/each}}
  Review what went wrong and take a different approach.
{{/if}}

{{#if parent}}
  ## Parent Issue #{{parent.number}}
  [{{parent.type}}]:
  {{parent.title}}
  {{#if parent.hypothesis}}
    Hypothesis:
    {{parent.hypothesis.statement}}
    (confidence:
    {{parent.hypothesis.confidence}})
  {{/if}}
{{/if}}

{{#if siblings}}
  ## Sibling Issues
  {{#each siblings}}
    - #{{this.number}}
    [{{this.status}}]:
    {{this.title}}
  {{/each}}
{{/if}}

{{#if goal}}
  ## Goal
  {{goal.title}}
  Progress:
  {{goal.currentValue}}{{goal.unit}}
  → target
  {{goal.targetValue}}{{goal.unit}}
{{/if}}

{{#if blocking}}
  ## ⚡ Urgency These issues are waiting on you:
  {{#each blocking}}
    - #{{this.number}}:
    {{this.title}}
  {{/each}}
{{/if}}
```

**Template variables available:**

| Variable               | Source                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `{{issue.*}}`          | All issue fields (number, title, description, type, priority, status, signalSource, signalPayload, hypothesis) |
| `{{parent.*}}`         | Parent issue fields (if parentId set)                                                                          |
| `{{siblings}}`         | Other children of the same parent                                                                              |
| `{{children}}`         | Child issues (if this is a root issue)                                                                         |
| `{{project.*}}`        | Project fields (name, description, status, health)                                                             |
| `{{goal.*}}`           | Goal fields (title, metric, targetValue, currentValue, unit)                                                   |
| `{{labels}}`           | Issue labels                                                                                                   |
| `{{blocking}}`         | Issues this issue is blocking                                                                                  |
| `{{blockedBy}}`        | Issues blocking this issue                                                                                     |
| `{{previousSessions}}` | Previous agent sessions on this issue (status, summary)                                                        |
| `{{loopUrl}}`          | Loop API base URL                                                                                              |
| `{{loopToken}}`        | API bearer token for callbacks                                                                                 |
| `{{meta.templateId}}`  | Template ID (for prompt reviews)                                                                               |
| `{{meta.versionId}}`   | Version ID (for prompt reviews)                                                                                |

### Prompt Versioning

Template content is versioned. Every edit creates a new version. You can always roll back.

```
PromptVersion {
  id:              UUID
  templateId:      UUID            // Parent template
  version:         Int             // Sequential (1, 2, 3...)
  content:         Text            // The Handlebars template text
  changelog:       Text?           // What changed from previous version
  authorType:      human | agent
  authorName:      String
  status:          active | draft | retired

  // Usage metrics (accumulated over time)
  usageCount:      Int             // Times dispatched with this version
  completionRate:  Float?          // % of issues that reached "done" (not canceled/blocked)
  avgDurationMs:   Float?          // Average time from dispatch to completion
  reviewScore:     Float?          // Average score from PromptReviews

  createdAt:       DateTime
}
```

### Prompt Reviews (Agent Feedback)

After completing work, agents rate the prompt they were given. This is the raw data that drives prompt improvement.

```
PromptReview {
  id:              UUID
  versionId:       UUID            // Which version was used
  issueId:         UUID            // Which issue it was used for

  // Structured feedback
  clarity:         Int (1-5)       // Was the prompt clear?
  completeness:    Int (1-5)       // Enough context provided?
  relevance:       Int (1-5)       // Instructions matched the actual work?
  feedback:        Text            // Free-form: what was missing, confusing, unnecessary

  authorType:      human | agent
  createdAt:       DateTime
}
```

Every dispatched prompt ends with review instructions:

```
## After Completion
Rate the quality of these instructions:

POST {{loopUrl}}/api/prompt-reviews
{
  "versionId": "{{meta.versionId}}",
  "issueId": "{{issue.id}}",
  "clarity": <1-5>,
  "completeness": <1-5>,
  "relevance": <1-5>,
  "feedback": "<what was missing, confusing, or unnecessary>"
}
```

This is low-overhead — one extra API call at the end of every agent session.

### The Prompt Improvement Loop

Reviews accumulate. When a template's average review score drops below a threshold (configurable, default 3.5/5) or accumulates N reviews since last update (configurable, default 15), **Loop creates an issue**:

```
Issue: "Improve prompt template: task-execute (avg review 3.6/5, 23 reviews since v5)"
Type: task
Labels: [prompt-improvement, meta]
Description: |
  The task-execute prompt template (v5) has received 23 reviews since its last
  update with an average score of 3.6/5.

  Common feedback themes:
  - "Missing: should specify branch naming convention" (mentioned 8 times)
  - "Unclear: when to create sub-issues vs handle inline" (mentioned 5 times)
  - "Unnecessary: API reference section is too long" (mentioned 3 times)

  Review the full feedback and propose an improved version.
```

This issue enters the dispatch queue like any other. An agent picks it up and gets a special `prompt-improvement` template:

```handlebars
You are improving a prompt template for the Loop project tracker. ## Template Name:
{{template.name}}
({{template.slug}}) Current version: v{{currentVersion.version}}
Usage:
{{currentVersion.usageCount}}
dispatches,
{{currentVersion.completionRate}}% completion rate ## Current Template Content
```

{{currentVersion.content}}

```

## Agent Reviews ({{reviews.length}} since last update)
Average scores: clarity {{avgClarity}}/5, completeness {{avgCompleteness}}/5, relevance {{avgRelevance}}/5

{{#each reviews}}
### Review from issue #{{this.issueNumber}} ({{this.authorType}})
Scores: clarity={{this.clarity}} completeness={{this.completeness}} relevance={{this.relevance}}
Feedback: "{{this.feedback}}"
{{/each}}

## Your Task
1. Analyze the feedback patterns — what's consistently missing, confusing, or unnecessary?
2. Draft an improved version of the template that addresses the common issues.
3. Do NOT change the template's core purpose or API reference sections.
4. Submit the new version as a draft:

POST {{loopUrl}}/api/templates/{{template.id}}/versions
{
  "content": "<new template content>",
  "changelog": "<what you changed and why>",
  "status": "draft"
}

5. Mark this issue as done.
```

New versions start as `draft`. A human reviews and promotes to `active` via the dashboard or CLI (`loop templates promote <version-id>`). For teams that trust the loop: auto-promote if the previous version's completion rate was below a threshold.

**The meta-loop:**

```
Agent uses prompt v5
  → Agent reviews prompt (scores 3/5 clarity)
    → Reviews accumulate (avg drops to 3.6)
      → Loop creates "improve prompt" issue
        → Agent reads reviews, proposes v6 (draft)
          → Human approves v6 → active
            → Agent uses prompt v6
              → Agent reviews prompt (scores 4.5/5 clarity) ✓
```

The prompts improve through the same loop as everything else. No special infrastructure. No AI in Loop. Just issues, data, and agents.

---

## The Loop (End to End)

Here's how the full loop works with the pull model:

### Step 1: Signal Arrives

A webhook hits Loop's signal endpoint:

```
POST /api/signals
{
  "source": "posthog",
  "type": "metric-change",
  "severity": "high",
  "payload": {
    "metric": "signup_conversion_rate",
    "previous": 3.6,
    "current": 3.2,
    "change": -0.12,
    "period": "24h"
  }
}
```

Loop creates a Signal record and a triage issue:

```
Issue #31: "PostHog: sign-up conversion -12% (24h)"
type: signal
status: triage (auto-promoted to todo for immediate processing)
priority: 2 (high, derived from severity)
signalSource: "posthog"
signalPayload: { ... }
```

### Step 2: DorkOS Polls, Gets Triage Work

DorkOS Pulse fires every 5 minutes. Calls `GET /api/dispatch/next`.

Loop selects the `posthog-metric-triage` template (matches conditions `{ type: signal, signalSource: posthog }` with specificity 20, beating the generic `signal-triage` at specificity 10).

Returns the issue + the hydrated prompt.

### Step 3: Agent Triages, Creates Hypothesis

The DorkOS agent analyzes the signal, checks git log, finds PR #847 (OAuth redirect change). Creates a hypothesis via Loop API:

```
POST /api/issues
{
  "title": "OAuth redirect change (PR #847) caused conversion drop",
  "type": "hypothesis",
  "parentId": "<signal-issue-id>",
  "projectId": "<onboarding-project-id>",
  "hypothesis": {
    "statement": "The new OAuth redirect flow adds 1.5-3s of blank white screen, causing users to abandon sign-up",
    "confidence": 0.82,
    "evidence": ["PR #847 merged 26 hours ago", "No other significant changes", "Error rates unchanged"],
    "validationCriteria": "Conversion rate returns to >3.4% within 48h after fix",
    "prediction": "Adding a loading state will reduce perceived latency and restore conversion"
  }
}
```

Note: The hypothesis is a child of the signal (parentId → #31). Since #31 is a root issue (no parent), this is valid.

### Step 4: DorkOS Polls, Gets Hypothesis Work

Next poll, Loop returns the hypothesis issue. The agent plans work and creates sibling issues under the same signal parent:

```
POST /api/issues { "title": "Add loading spinner to OAuth redirect", "type": "task", "parentId": "<signal-issue-id>", "priority": 2 }
POST /api/issues { "title": "Add PostHog tracking to redirect latency", "type": "task", "parentId": "<signal-issue-id>", "priority": 3 }
POST /api/issues { "title": "Monitor: conversion recovery after fix", "type": "monitor", "parentId": "<signal-issue-id>", "priority": 3 }
POST /api/issues/:task-42/relations { "type": "blocks", "relatedIssueId": "<monitor-issue-id>" }
```

The resulting structure:

```
Signal #31: "PostHog: sign-up conversion -12%"
├── Hypothesis #35: "OAuth redirect caused conversion drop"
├── Task #42: "Add loading spinner" (blocks → #46)
├── Task #43: "Add PostHog tracking"
└── Monitor #46: "Monitor conversion recovery" (blocked_by → #42)
```

All siblings. Relations handle ordering. 1 level deep.

### Steps 5-7: Execute → Monitor → Loop

DorkOS polls → dispatches Task #42 and #43 (unblocked) → agents code, create PRs → Monitor #46 becomes unblocked → agent checks outcomes → hypothesis validated or invalidated → new signals feed back in.

The entire loop runs with **zero AI in Loop**. Loop is a smart to-do list. DorkOS is the muscle.

---

## API Endpoints

### Core CRUD

```
GET    /api/issues              # List issues (filterable by status, type, project, label, priority)
POST   /api/issues              # Create issue (validates 1-level parent constraint)
GET    /api/issues/:id          # Get issue with parent, children, relations
PATCH  /api/issues/:id          # Update issue (status, summary, commits, PRs, etc.)
DELETE /api/issues/:id          # Delete issue

GET    /api/projects            # List projects
POST   /api/projects            # Create project
GET    /api/projects/:id        # Get project with issues + goal
PATCH  /api/projects/:id        # Update project
DELETE /api/projects/:id        # Delete project

GET    /api/goals               # List goals
POST   /api/goals               # Create goal
PATCH  /api/goals/:id           # Update goal (currentValue, status)
DELETE /api/goals/:id           # Delete goal

GET    /api/labels              # List labels
POST   /api/labels              # Create label
DELETE /api/labels/:id          # Delete label
```

### Signal Ingestion

```
POST   /api/signals             # Receive signal → creates triage issue
POST   /api/signals/posthog     # PostHog webhook handler
POST   /api/signals/github      # GitHub webhook handler
POST   /api/signals/sentry      # Sentry webhook handler
```

### Dispatch (Pull Interface)

```
GET    /api/dispatch/next              # Get next issue + hydrated prompt (marks as in_progress)
GET    /api/dispatch/next?project=uuid # Filter to specific project
GET    /api/dispatch/queue             # Preview dispatch queue (without claiming)
```

### Relations

```
POST   /api/issues/:id/relations   # Create relation (blocks, blocked_by, related, duplicate)
DELETE /api/relations/:id           # Remove relation
```

### Comments

```
GET    /api/issues/:id/comments    # List comments
POST   /api/issues/:id/comments    # Add comment
```

### Prompt Templates

```
GET    /api/templates                  # List templates with active version info
POST   /api/templates                  # Create template
PATCH  /api/templates/:id              # Update template metadata (conditions, specificity)
DELETE /api/templates/:id              # Delete template

GET    /api/templates/:id/versions     # List versions for a template
POST   /api/templates/:id/versions     # Create new version (draft or active)
PATCH  /api/templates/:id/versions/:vid # Update version (promote draft → active, retire)
GET    /api/templates/preview/:issueId # Preview: select template + hydrate for an issue

POST   /api/prompt-reviews             # Submit a prompt review
GET    /api/templates/:id/reviews      # List reviews for a template
```

### Dashboard Data

```
GET    /api/dashboard/stats        # Issue counts by status/type; goal progress; loop velocity
GET    /api/dashboard/loop         # Recent loop activity (signal → hypothesis → task → outcome)
GET    /api/dashboard/prompts      # Prompt health: usage counts, review scores, versions
```

---

## Tech Stack

| Layer          | Technology                             | Rationale                                                             |
| -------------- | -------------------------------------- | --------------------------------------------------------------------- |
| **API**        | Node.js + Hono                         | Fast, TypeScript-native, lightweight                                  |
| **Database**   | PostgreSQL + Drizzle ORM               | Relational integrity for issue hierarchies, JSONB for signal payloads |
| **Templating** | Handlebars                             | Battle-tested, logic-light, easy for humans and agents to author      |
| **Frontend**   | React 19 + Vite + Tailwind + shadcn/ui | Consistent with DorkOS ecosystem                                      |
| **Deployment** | Cloud (Render/Railway/Fly.io)          | Public endpoints for webhooks, accessible by DorkOS instances         |
| **Auth**       | API key (MVP)                          | Simple bearer token for agent access. Multi-user auth in v1.          |

No queue system. No MCP server. No AI runtime. No vector database. No GPU instances.

---

## React Dashboard

The dashboard provides visibility into the loop. Five views:

### 1. Issue List

Default view. Filterable table of all issues.

- Columns: number, title, type, status, priority, project, labels, created, updated
- Filters: status, type, project, label, priority
- Click → issue detail panel

### 2. Issue Detail

Side panel or full page showing:

- Issue metadata (type, status, priority, project, labels)
- Description (markdown rendered)
- Parent issue (if child) or children (if root)
- Relations (blocking/blocked by)
- Agent results (summary, commits, PRs)
- Comments (threaded)
- Signal data (if type=signal)
- Hypothesis data (if type=hypothesis)

### 3. Loop Activity

A timeline/feed showing the loop in action:

- Signal #31 received (PostHog: conversion -12%)
- → Hypothesis #35 created (OAuth redirect friction, confidence 0.82)
- → Task #42 created (Add loading spinner)
- → Task #42 completed (PR #851 merged)
- → Monitor #46 checking (48h observation period)
- → Hypothesis #35 validated (conversion recovered to 3.5%)

This is the "wow" view — shows the autonomous loop working.

### 4. Goals Dashboard

Overview of all active goals with progress indicators:

- Goal title, target, current value, trend arrow
- Linked project status
- Issues contributing to this goal

### 5. Prompt Health

Overview of all prompt templates with quality metrics:

- Template name, slug, active version, usage count
- Average review score (clarity, completeness, relevance)
- Completion rate (% of dispatched issues that reached "done")
- Version history with changelogs
- "Needs attention" flag when review score drops below threshold

---

## CLI

```bash
# Issue management
loop list                              # List issues (default: current + recent)
loop list --status todo                # Filter by status
loop list --type signal                # Filter by type
loop list --project "onboarding"       # Filter by project
loop show 42                           # Issue detail with parent + children
loop create "Fix login timeout"        # Create issue
loop create --type bug --priority 2 "Login times out after 30s"

# Signal submission
loop signal "Users reporting slow checkout"              # Manual signal
loop signal --source manual --severity medium "..."      # With metadata

# Triage
loop triage                            # Show triage queue
loop triage accept 31                  # Accept into backlog
loop triage decline 32 "Noise"         # Decline with reason

# Projects and goals
loop projects                          # List projects
loop goals                             # List goals with progress

# Prompt templates
loop templates                         # List templates with review scores
loop templates show task-execute       # Show template details + version history
loop templates promote <version-id>    # Promote draft version to active

# Dispatch (for debugging/manual use)
loop next                              # Preview what dispatch/next would return
loop dispatch 42                       # Manually mark issue for dispatch

# Configuration
loop config set url https://loop.example.com
loop config set token tok_...

# Status
loop status                            # Loop health: queue depth, active issues, goal progress
```

---

## Default Prompt Templates

Five default templates ship with Loop, one per issue type.

### Signal Triage (`conditions: { "type": "signal" }`, specificity: 10)

````handlebars
You are triaging a signal for the Loop project tracker.

## Signal
Source: {{issue.signalSource}}
Severity: {{issue.priority_label}}
{{issue.title}}

{{#if issue.signalPayload}}
Raw data:
```json
{{json issue.signalPayload}}
````

{{/if}}

{{> project_and_goal_context}}

## Your Task

1. Analyze this signal. Is it actionable or noise?
2. If actionable, determine the likely cause and create a hypothesis issue as a child of this signal.
3. If noise, mark this signal as canceled with an explanation.

{{> api_reference}}
{{> review_instructions}}

````

### Hypothesis Planning (`conditions: { "type": "hypothesis" }`, specificity: 10)

```handlebars
You are planning work based on a hypothesis.

## Hypothesis
{{issue.hypothesis.statement}}
Confidence: {{issue.hypothesis.confidence}}
Validation criteria: {{issue.hypothesis.validationCriteria}}

{{#if issue.hypothesis.evidence}}
Evidence:
{{#each issue.hypothesis.evidence}}- {{this}}
{{/each}}
{{/if}}

{{> parent_context}}
{{> project_and_goal_context}}

## Your Task
1. Break this hypothesis into concrete, implementable tasks.
2. Create each task as a child of this issue's parent (sibling of this hypothesis).
3. Each task should be completable in a single agent session.
4. Include a monitoring issue to validate the hypothesis after implementation.
5. Use blocking relations if tasks must be done in order.

{{> api_reference}}
{{> review_instructions}}
````

### Task Execution (`conditions: { "type": "task" }`, specificity: 10)

```handlebars
You are implementing a task.

## Task
{{issue.title}}

{{#if issue.description}}
{{issue.description}}
{{/if}}

{{> parent_context}}
{{> sibling_context}}
{{> project_and_goal_context}}

{{#if previousSessions}}
## ⚠️ Previous Attempts
{{#each previousSessions}}
- Attempt: {{this.status}} — {{this.agentSummary}}
{{/each}}
Review what went wrong and take a different approach.
{{/if}}

{{#if blocking}}
## ⚡ These issues are waiting on you
{{#each blocking}}- #{{this.number}}: {{this.title}}
{{/each}}
{{/if}}

## Your Task
1. Implement the described change.
2. Write tests.
3. Create a PR from a feature branch.
4. Report results back to Loop.

{{> api_reference}}
{{> review_instructions}}
```

### Plan Decomposition (`conditions: { "type": "plan" }`, specificity: 10)

```handlebars
You are decomposing a plan into implementable tasks.

## Plan
{{issue.title}}

{{#if issue.description}}
{{issue.description}}
{{/if}}

{{> parent_context}}
{{> project_and_goal_context}}

## Your Task
1. Break this plan into concrete tasks.
2. Create each task as a sibling (child of the same parent).
3. Set up blocking relations for execution ordering.
4. Each task should be independently completable by an agent.

{{> api_reference}}
{{> review_instructions}}
```

### Monitor Check (`conditions: { "type": "monitor" }`, specificity: 10)

```handlebars
You are checking the outcome of a hypothesis.

## What to Check
{{issue.description}}

{{#if parentHypothesis}}
## Hypothesis
Statement: {{parentHypothesis.hypothesis.statement}}
Validation criteria: {{parentHypothesis.hypothesis.validationCriteria}}
Prediction: {{parentHypothesis.hypothesis.prediction}}
{{/if}}

{{> project_and_goal_context}}

## Your Task
1. Check if the validation criteria have been met.
2. If met: update the parent hypothesis to "done" and add a comment with evidence. Update the goal's currentValue if applicable.
3. If not met: add a comment with current status. If clearly failed, update parent hypothesis to "canceled".
4. If inconclusive: add a comment and create a new monitor issue (sibling) to check again later.

{{> api_reference}}
{{> review_instructions}}
```

### Shared Partials

Templates use Handlebars partials for common sections:

- `{{> api_reference}}` — Curl examples for creating issues, updating status, adding comments, creating relations
- `{{> review_instructions}}` — Instructions for submitting a prompt review after completion
- `{{> parent_context}}` — Parent issue info (if this is a child issue)
- `{{> sibling_context}}` — Other children of the same parent
- `{{> project_and_goal_context}}` — Project name, description, goal progress

---

## What's NOT in the MVP

| Deferred                          | Why it can wait                                                 |
| --------------------------------- | --------------------------------------------------------------- |
| Teams / multi-team                | Single team is fine for proving the loop                        |
| Cycles                            | Continuous operation; measurement windows can come later        |
| Initiatives                       | Strategic layer; projects + goals are sufficient                |
| Workflow states as entities       | Fixed status enum works; per-team customization is a v1 feature |
| Customers / CRM                   | Signals don't need to know who sent them for MVP                |
| Custom views                      | Default views are sufficient                                    |
| Feedback widget                   | Manual signals via CLI/webhook are enough                       |
| Multi-user auth                   | Single user + API key for MVP                                   |
| MCP server                        | REST API is sufficient; MCP is a nicer wrapper for later        |
| Multiple agent backends           | DorkOS-only via Pulse polling                                   |
| Auto-merge pipeline               | Agent creates PRs; human merges for MVP (safer)                 |
| Hypothesis confidence calibration | Track manually; auto-calibration is v1                          |
| Signal deduplication              | Simple title matching; semantic dedup is v1                     |
| Auto-promote prompt versions      | Human approves for MVP; auto-promote is v1                      |

---

## What IS in the MVP

| Feature                                           | Purpose                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Issues** (full CRUD, 1-level hierarchy)         | The atomic unit — signals, hypotheses, plans, tasks, monitors                |
| **Projects**                                      | Multi-project from day 1                                                     |
| **Goals**                                         | Success indicators — "is the loop actually improving things?"                |
| **Labels**                                        | Categorization — bugs vs features vs infrastructure                          |
| **Issue Relations**                               | Blocking/blocked — execution ordering                                        |
| **Comments**                                      | Agent + human communication on issues                                        |
| **Signals**                                       | Raw incoming data with webhook endpoints                                     |
| **Dispatch endpoint**                             | Pull-based: selects template by conditions, hydrates, returns issue + prompt |
| **Prompt templates** (conditions-based selection) | Right prompt for the right context                                           |
| **Prompt versioning**                             | Version history, rollback, usage metrics                                     |
| **Prompt reviews**                                | Agent feedback on prompt quality                                             |
| **Prompt improvement loop**                       | Auto-creates issues when prompt quality degrades                             |
| **Priority logic**                                | Deterministic scoring for "what's next"                                      |
| **React dashboard**                               | Issue list, detail, loop activity, goals, prompt health                      |
| **CLI**                                           | Issue management, signal submission, triage, template management             |
| **Cloud deployment**                              | Public endpoints for webhooks                                                |

---

## Competitive Positioning

Loop occupies the intersection of issue tracking + autonomous agent execution + closed feedback loop. No existing product covers all three.

The "no AI" architecture is the strongest competitive moat:

1. **Any agent can use Loop** — not just DorkOS. Any tool that can make HTTP calls can poll `/api/dispatch/next`.
2. **No vendor lock-in** on the agent side — swap DorkOS for Devin, Codex, or a custom agent without changing Loop.
3. **No AI costs** — Loop is free to run (just hosting + Postgres). All AI costs are on the agent side.
4. **Automatically improves** — every new model release makes every Loop installation better, worldwide, instantly.
5. **Fully on-prem** — organizations with data sovereignty requirements can run Loop + local models with zero external dependencies.
6. **Self-improving prompts** — the prompt review/improvement loop means the system's instructions get better over time, independent of model improvements.

---

## Roadmap (Post-MVP)

### v0.1: The Loop Works

Everything in the "What IS in the MVP" table above.

### v0.2: Refined Intelligence

- More signal-source-specific prompt templates (PostHog, Sentry, GitHub)
- Hypothesis tracking dashboard (hit rate, confidence calibration)
- Auto-merge pipeline (agent PR → CI passes → auto-merge)
- Signal deduplication (simple title/payload matching)
- Auto-promote prompt versions when completion rate improves
- Feedback widget (embeddable JS)

### v0.3: Team Scale

- Multi-user auth (Better Auth or Clerk)
- Teams + per-team workflow states (Linear-style)
- Cycles (observation windows with metrics)
- Custom views (saved filters)

### v1.0: Platform

- MCP server (nicer agent interface than REST)
- Multiple agent backend support
- Initiatives (strategic hierarchy)
- Customer/CRM entities
- Linear sync (bidirectional)
- Plugin system for custom signal sources
- Prompt marketplace (community-shared templates)

---

## Open Questions (Reduced)

1. **Prompt template authoring UX**: How do users edit prompt templates in the dashboard? Code editor with Handlebars syntax highlighting? Live preview with a sample issue?

2. **Goal tracking**: How are `currentValue` updates fed in? Manually? Via a signal-to-goal mapping? Via a dedicated PostHog query?

3. **Dispatch concurrency**: If DorkOS polls every 5 minutes and an issue takes 30 minutes, what prevents double-dispatch? The atomic `status = in_progress` update handles this, but should there also be a timeout that returns in_progress issues to todo if no result is reported within N minutes?

4. **Agent identity**: When an agent calls the Loop API, how do we know which DorkOS instance is calling? Single API key, or per-instance keys?

5. **Prompt review quality**: Will agent self-reviews be useful, or will they be systematically biased? Should we weight human reviews higher than agent reviews?

---

## Summary

Loop MVP is:

- **A fully deterministic cloud web app** (Node.js + Hono + Postgres + Drizzle + React)
- **With zero AI** — no LLM calls, no embeddings, no inference, no model dependencies
- **With a data model** (Issues, Projects, Goals, Labels, Relations, Comments, Signals, PromptTemplates, PromptVersions, PromptReviews)
- **With conditions-based prompt selection** (right template for the right context)
- **With a self-improving prompt layer** (agent reviews → quality tracking → improvement issues → better prompts)
- **With a pull-based dispatch interface** (`/api/dispatch/next` returns issue + hydrated prompt)
- **With webhook ingestion** (signals from PostHog, GitHub, Sentry, manual)
- **With a CLI** (issue management, signal submission, triage, template management)
- **With a React dashboard** (issue list, detail, loop activity, goals, prompt health)

DorkOS Pulse polls Loop on a schedule. Loop returns work + instructions. DorkOS executes. Agent reports back via REST API. The prompts improve over time through agent feedback. The loop runs itself.

**Loop gets better every time a new AI model is released — without changing a single line of code.**
