---
title: "Linear Domain Model: Comprehensive Research"
date: 2026-02-18
type: exploratory
status: archived
tags: [linear, domain-model, issue-tracking, webhook, sdk]
searches_performed: 18
---

# Linear Domain Model: Comprehensive Research

**Date**: 2026-02-18
**Research Depth**: Deep
**Searches Performed**: 18
**Primary Sources**: Linear official docs, Linear GitHub SDK schema, Linear changelog, Linear developer docs, webhook payload examples

---

## Research Summary

Linear's domain model is a hierarchical, team-scoped system with Issues as the atomic unit. The organizational hierarchy flows from Workspace → Teams → Issues, with Projects and Cycles as orthogonal grouping dimensions across teams, and Initiatives as the top-level portfolio layer. The GraphQL API is the single integration surface, with webhooks reflecting the same schema. As of early 2026, Linear has added AI-powered triage intelligence, an MCP server, and agent capabilities.

---

## 1. Entity Hierarchy (Top to Bottom)

```
Workspace (Organization)
├── Users (Members)
├── Teams
│   ├── WorkflowStates (per-team, customizable)
│   ├── Cycles (per-team sprints)
│   ├── IssueLabels (per-team, inheritable)
│   └── Issues
│       ├── Comments (threaded)
│       ├── Attachments
│       ├── IssueRelations (blocks/blocked-by/related/duplicate)
│       └── Sub-Issues (child Issues, recursive)
├── Projects (cross-team)
│   ├── ProjectMilestones
│   ├── ProjectUpdates
│   └── Issues (assigned to project)
├── Initiatives (workspace-level)
│   ├── Sub-Initiatives (nested, up to 5 levels)
│   ├── InitiativeUpdates
│   └── Projects (assigned to initiative)
├── CustomViews (saved filters)
├── Customers (CRM entities)
│   └── CustomerRequests (Asks feature)
└── Documents
```

### Key structural rules

- An Issue **must** belong to exactly one Team.
- An Issue belongs to **at most one Project** (not multiple).
- An Issue belongs to **at most one Cycle** (per team, at a time).
- An Issue can have **at most one parent** Issue (sub-issue relationship).
- Projects can span **multiple Teams**.
- Initiatives are **workspace-level** and contain Projects.
- Initiatives can be **nested** (parentInitiative field, up to 5 levels deep).
- WorkflowStates are **per-team** — each team has its own state machine.

---

## 2. Core Entity: Issue

The Issue is Linear's fundamental unit. Every other concept either contains Issues or groups them.

### Identifier format

`{TEAM_KEY}-{NUMBER}` — e.g., `ENG-123`. The number is sequential per team.

### Fields (confirmed from webhook payloads and SDK)

```
id:               UUID (primary key)
createdAt:        DateTime
updatedAt:        DateTime
archivedAt:       DateTime (nullable)
number:           Int (sequential per-team, immutable)
title:            String (required)
description:      String (markdown, nullable)
descriptionData:  String (Prosemirror JSON, nullable)
priority:         Int (0=No Priority, 1=Urgent, 2=High, 3=Medium, 4=Low)
estimate:         Float (nullable, story points)
sortOrder:        Float (for manual ordering)
startedAt:        DateTime (nullable, when moved to Started category)
completedAt:      DateTime (nullable, when moved to Completed category)
canceledAt:       DateTime (nullable, when moved to Canceled category)
autoClosedAt:     DateTime (nullable)
autoArchivedAt:   DateTime (nullable)
dueDate:          TimelessDate (nullable, date without time)
snoozedUntilAt:   DateTime (nullable, triage snooze)

-- Relations (stored as foreign keys)
teamId:           UUID (required, owning team)
stateId:          UUID (required, WorkflowState)
assigneeId:       UUID (nullable, User)
creatorId:        UUID (User who created)
projectId:        UUID (nullable, parent Project)
cycleId:          UUID (nullable, current Cycle)
parentId:         UUID (nullable, parent Issue for sub-issues)
labelIds:         [UUID] (array of IssueLabel IDs)
```

### Priority encoding (confirmed)

| Integer | Label       |
|---------|-------------|
| 0       | No Priority |
| 1       | Urgent      |
| 2       | High        |
| 3       | Medium      |
| 4       | Low         |

Urgent priority triggers automatic email notifications to the assignee.

### Estimate types (team-level configuration)

The team's `estimateType` field controls which scale is used:
- `notUsed` — estimates disabled
- `exponential` — 1, 2, 4, 8, 16...
- `fibonacci` — 1, 2, 3, 5, 8, 13, 21...
- `linear` — 1, 2, 3, 4, 5...
- `tShirt` — XS(1), S(2), M(3), L(5), XL(8), XXL(13), XXXL(21)

Estimates are stored as `Float` regardless of display mode.

### Sub-issue behavior

- Sub-issues are just Issues with a non-null `parentId`.
- Nesting is recursive (sub-sub-issues possible).
- When a parent Issue has a Project or Cycle set before sub-issue creation, the sub-issue inherits those.
- Team is NOT automatically inherited.
- Labels and assignees are NOT automatically inherited.
- Optional automations (team-level): auto-close parent when all sub-issues done; auto-close sub-issues when parent closes.

---

## 3. WorkflowState (Issue Statuses)

Workflow states are **per-team** — each team defines its own named states, but they must map to one of six fixed **type categories**.

### State type categories (enum values)

| Type        | Meaning                                   |
|-------------|-------------------------------------------|
| `triage`    | Inbox state, excluded from normal views   |
| `backlog`   | Unstarted, default for new issues         |
| `unstarted` | Todo (pre-work, before active work)       |
| `started`   | In progress                               |
| `completed` | Done                                      |
| `canceled`  | Rejected/closed                           |

### WorkflowState fields

```
id:            UUID
createdAt:     DateTime
updatedAt:     DateTime
archivedAt:    DateTime (nullable)
name:          String (team-defined, e.g., "In Review")
description:   String (nullable)
type:          String (enum: triage|backlog|unstarted|started|completed|canceled)
color:         String (hex color)
position:      Float (ordering within category)
teamId:        UUID (owning team)
inheritedFrom: UUID (nullable, for sub-team inheritance)
```

### Default progression

`Backlog → Todo → In Progress → Done → Canceled`

Each team gets this default and can customize names, colors, add custom states within categories, and set any Backlog/Unstarted state as the default for new issues.

### Triage state special behavior

- Triage is **opt-in** per team (configurable in Settings).
- Issues in Triage are **excluded from all views** by default.
- If Triage is enabled and no state is specified on issue creation (e.g., from integrations, non-team-members), issues land in the Triage state.
- From Triage, issues can be: Accepted (→ default Backlog state), Duplicated (→ Canceled), Declined (→ Canceled), or Snoozed (temporarily hidden, returns on date or new activity).

---

## 4. Team

Teams are the primary organizational unit beneath the Workspace. Every Issue must belong to exactly one Team.

### Team fields (confirmed)

```
id:                    UUID
createdAt:             DateTime
updatedAt:             DateTime
archivedAt:            DateTime (nullable)
name:                  String
key:                   String (short identifier, e.g., "ENG")
description:           String (nullable)
icon:                  String (nullable)
color:                 String (hex, nullable)
private:               Boolean
cyclesEnabled:         Boolean (whether team uses Cycles)
triageEnabled:         Boolean (whether Triage inbox is enabled)
estimateType:          String (notUsed|exponential|fibonacci|linear|tShirt)
issueEstimation:       Boolean
defaultIssueEstimate:  Float
inheritEstimation:     Boolean (sub-teams inherit parent settings)
issueOrderingNoPriorityFirst: Boolean
upcomingCycleCount:    Int
autoArchivePeriod:     Float (days after completion before auto-archive)
autoClosePeriod:       Float (days before auto-close)
timezone:              String
```

Teams can have sub-teams (parent/child Team relationships). Sub-teams can inherit estimation settings from parent.

---

## 5. Project

Projects are **cross-team, time-bound deliverables**. They group Issues from one or more Teams toward a specific goal.

### Critical constraint

An Issue can belong to **at most one Project** at a time (confirmed from docs: "Issues can only be associated with one project at a time").

### Project fields (confirmed from webhook payloads and SDK)

```
id:           UUID
createdAt:    DateTime
updatedAt:    DateTime
archivedAt:   DateTime (nullable)
name:         String (required)
description:  String (markdown, nullable)
content:      String (rich text document)
icon:         String (nullable)
color:        String (hex, nullable)
priority:     Int (same 0-4 scale as Issues, added 2024)
state:        String (status category: backlog|planned|started|paused|completed|canceled)
progress:     Float (0.0 to 1.0, auto-calculated from issue completion)
health:       String (enum: onTrack|atRisk|offTrack — manually set)
startDate:    TimelessDate (nullable)
targetDate:   TimelessDate (nullable)
completedAt:  DateTime (nullable)
canceledAt:   DateTime (nullable)
url:          String
slugId:       String
leadId:       UUID (nullable, project lead User)
creatorId:    UUID
```

### Project status categories

Projects use **five base categories**, each supporting custom named statuses:

| Category    | Built-in meaning                  |
|-------------|-----------------------------------|
| `backlog`   | Early-stage concept               |
| `planned`   | Ready for execution               |
| `started`   | Currently in progress             |
| `completed` | Finished                          |
| `canceled`  | Abandoned                         |

Additionally, `paused` appears automatically under Planned for paused projects.

**Project statuses are manually updated** — Linear does not auto-complete projects even when all issues are done.

### Project milestones

ProjectMilestone fields:
```
id:          UUID
name:        String
description: String (nullable)
targetDate:  TimelessDate (nullable)
sortOrder:   Float
projectId:   UUID
```

### ProjectUpdate (health update posts)

```
id:          UUID
createdAt:   DateTime
updatedAt:   DateTime
body:        String (markdown)
health:      String (onTrack|atRisk|offTrack)
projectId:   UUID
userId:      UUID (author)
```

---

## 6. Cycle

Cycles are **per-team sprints**. They are time-boxed, recurring, and do not necessarily end in a release. Incomplete issues auto-roll to the next cycle.

### Cycle fields (confirmed from webhook payloads)

```
id:                          UUID
createdAt:                   DateTime
updatedAt:                   DateTime
archivedAt:                  DateTime (nullable)
number:                      Int (sequential per team)
name:                        String (nullable, optional display name)
description:                 String (nullable)
startsAt:                    DateTime
endsAt:                      DateTime
completedAt:                 DateTime (nullable)
progress:                    Float (0.0 to 1.0)
teamId:                      UUID

-- Burndown/burnup history arrays (one entry per day)
scopeHistory:                [Float] (total scope points over time)
completedScopeHistory:       [Float] (completed scope over time)
inProgressScopeHistory:      [Float] (in-progress scope over time)
completedIssueCountHistory:  [Int]   (completed issue count over time)
issueCountHistory:           [Int]   (total issue count over time)
```

### Computed boolean fields (available on GraphQL, not stored)

```
isActive:   Boolean (current wall clock is within startsAt..endsAt)
isNext:     Boolean (upcoming cycle)
isPast:     Boolean (endsAt < now)
isFuture:   Boolean (startsAt > now)
isPrevious: Boolean (previous completed cycle)
```

An Issue has a `cycleId` FK. Issues are added to Cycles through the UI or API.

---

## 7. Initiative

Initiatives are **workspace-level portfolio containers** for Projects. They represent organizational goals/OKRs.

### Initiative fields (confirmed from SDK)

```
id:                UUID
createdAt:         DateTime
updatedAt:         DateTime
archivedAt:        DateTime (nullable)
name:              String
description:       String (nullable)
icon:              String (nullable)
color:             String (hex, nullable)
health:            String (onTrack|atRisk|offTrack, nullable)
status:            String (project-style status, nullable)
targetDate:        TimelessDate (nullable)
url:               String
slugId:            String
leadId:            UUID (nullable, initiative lead User)
parentInitiativeId: UUID (nullable, for nested Initiatives)
```

### InitiativeUpdate (progress posts)

```
id:            UUID
createdAt:     DateTime
updatedAt:     DateTime
body:          String (markdown)
health:        String (onTrack|atRisk|offTrack)
initiativeId:  UUID
userId:        UUID
```

### Initiative hierarchy

Initiatives can be nested up to 5 levels deep via `parentInitiativeId`. Each Initiative has a dedicated page showing its Projects and sub-Initiatives.

### Initiative-Project relationship

There is a **join table** between Projects and Initiatives (many-to-many join). A Project can appear in multiple Initiatives, and an Initiative contains multiple Projects.

---

## 8. IssueLabel

Labels are per-team (or workspace-level for shared labels). An Issue can have multiple labels.

### IssueLabel fields

```
id:          UUID
createdAt:   DateTime
updatedAt:   DateTime
archivedAt:  DateTime (nullable)
name:        String
description: String (nullable)
color:       String (hex)
teamId:      UUID (nullable, null = workspace-level label)
parentId:    UUID (nullable, for nested label groups)
creatorId:   UUID
```

Labels support hierarchical grouping via `parentId` (label groups).

---

## 9. IssueRelation

Issue relations link two Issues with a directional relationship type.

### Relation types (enum)

| API value    | Display       | Meaning                              |
|--------------|---------------|--------------------------------------|
| `blocks`     | Blocks        | This issue blocks the related issue  |
| `blocked`    | Blocked by    | This issue is blocked by the related |
| `related`    | Related to    | General association                  |
| `duplicate`  | Duplicate of  | This issue duplicates another        |

### IssueRelation fields

```
id:              UUID
createdAt:       DateTime
updatedAt:       DateTime
type:            String (blocks|blocked|related|duplicate)
issueId:         UUID (source issue)
relatedIssueId:  UUID (target issue)
```

Visual indicators in the UI:
- Orange flag = blocked-by
- Red flag = blocking another issue
- Green flag = blocking issue was resolved (converts to related)

---

## 10. Comment

Comments are threaded and support markdown with @mentions.

### Comment fields (confirmed from schema)

```
id:             UUID
createdAt:      DateTime
updatedAt:      DateTime
archivedAt:     DateTime (nullable)
body:           String (markdown)
bodyData:       String (Prosemirror JSON)
issueId:        UUID (parent issue)
userId:         UUID (author)
parentId:       UUID (nullable, for threaded replies)
resolvedAt:     DateTime (nullable, for resolved comments)
resolvingUserId: UUID (nullable)
reactions:      [Reaction] (emoji reactions)
```

---

## 11. Attachment

Attachments link external resources to Issues.

### Attachment fields

```
id:          UUID
createdAt:   DateTime
updatedAt:   DateTime
archivedAt:  DateTime (nullable)
title:       String
url:         String
sourceType:  String (nullable, e.g., "github", "sentry")
metadata:    JSONObject (source-specific data)
issueId:     UUID
creatorId:   UUID
```

---

## 12. Organization (Workspace)

The top-level container. A User can belong to multiple Organizations.

### Key Organization fields

```
id:                 UUID
createdAt:          DateTime
updatedAt:          DateTime
name:               String
urlKey:             String (subdomain slug)
logoUrl:            String (nullable)
samlEnabled:        Boolean
gitBranchFormat:    String (template for auto-branch names)
roadmapEnabled:     Boolean
projectUpdateRemindersDay: String
```

---

## 13. User

```
id:                 UUID
createdAt:          DateTime
updatedAt:          DateTime
archivedAt:         DateTime (nullable)
name:               String
displayName:        String
email:              String
avatarUrl:          String (nullable)
active:             Boolean
admin:              Boolean
isMe:               Boolean (relative to authenticated user)
```

---

## 14. Customer & CustomerRequest (Asks)

Linear's CRM-lite feature ("Asks") introduced Customers and CustomerRequests.

### Customer fields

```
id:        UUID
name:      String
domain:    String (unique)
logoUrl:   String (nullable)
owner:     User (nullable)
revenue:   Float (nullable)
size:      Int (nullable, employee count)
status:    String
tier:      String
```

### CustomerRequest (Need) fields

Links customer feedback to Issues.

```
id:              UUID
createdAt:       DateTime
body:            String (feedback text)
priority:        Int
issueId:         UUID (target issue)
customerId:      UUID
```

---

## 15. CustomView (Saved Filters)

```
id:            UUID
createdAt:     DateTime
updatedAt:     DateTime
name:          String
description:   String (nullable)
icon:          String (nullable)
color:         String (nullable)
filters:       JSONObject (filter definition)
teamId:        UUID (nullable, null = workspace-wide)
creatorId:     UUID
shared:        Boolean
```

### Visibility levels

- Personal (only creator sees it)
- Team-level (visible to team members)
- Workspace-level (visible to all)

---

## 16. Document

```
id:         UUID
createdAt:  DateTime
updatedAt:  DateTime
title:      String
content:    String (rich text)
projectId:  UUID (nullable)
creatorId:  UUID
```

---

## 17. Workflow Model in Detail

### State machine per team

Each team defines its own workflow states. States have a `type` (category) and a `position` (float for ordering within category). Categories cannot be reordered — only states within a category.

### Issue lifecycle

```
[Created] → Triage (optional) → Backlog/Unstarted → Started → Completed
                                                             ↘ Canceled
```

When Triage is enabled:
- Non-team-member-created issues and integration-created issues → Triage automatically
- Triaged issues can be: Accepted, Duplicated, Declined, or Snoozed

### Default state assignment

If `stateId` is omitted on `issueCreate`:
- With Triage enabled → lands in the single Triage state
- Without Triage → lands in team's default Backlog/Unstarted state (configurable)

---

## 18. Views and Filtering

### Filterable Issue properties (confirmed)

- Priority (integer comparator)
- Status / WorkflowState
- Assignee
- Labels (includes/excludes any/all)
- Project
- Cycle (active/upcoming/specific)
- Milestone
- Estimate
- Due date (before/after/relative ISO 8601 duration)
- Created date
- Completed date
- Updated date
- Creator
- Subscribers
- Content (full-text)
- Relations (blocked/blocking/parent/sub-issue)
- Auto-closed status

### Filter operators

- `eq`, `neq`, `in`, `nin` — equality
- `lt`, `lte`, `gt`, `gte` — numeric/date ranges
- `contains`, `notContains`, `containsIgnoreCase` — string matching
- `startsWith`, `endsWith` — string prefix/suffix
- `null` — presence check (field is null or not null)
- `or` — logical OR grouping across filters
- `every` — all must match (for many-to-many like labels)
- Relative dates via ISO 8601 durations (e.g., `P2W` = 2 weeks ago)

Advanced filters (added Feb 2026) support grouped AND/OR conditions with nesting.

### View types

- **Issue Views** — filter-based collections of Issues
- **Project Views** — filter by project status, lead, team, etc.
- **Initiative Views** — workspace-level portfolio view (no filters, curated)
- **My Issues** — assignee = viewer
- **Active Issues** — state type = started
- **Triage** — state type = triage (team-specific)

---

## 19. Linear's AI Features (as of 2026)

### Triage Intelligence (Business/Enterprise)

- Powered by agentic LLMs
- Analyzes incoming Triage issues against historical workspace data
- Suggests: **Team**, **Project**, **Assignee**, **Labels**
- Also surfaces likely **duplicates** via semantic similarity
- Takes 1-4 minutes per issue for full analysis (async)
- Can be configured per property: show suggestion, hide, or **auto-apply**
- Auto-apply can be scoped to specific values (e.g., auto-apply `bug` label but not others)
- Settings at workspace or per-team level
- Sub-teams inherit parent settings (with override support)
- Quick suggestions (faster, less thorough) available on all plans in issue composer

### Linear Agents

- AI agents that can work on Issues end-to-end
- Integrations with GitHub Copilot (Oct 2025), OpenAI Codex (Dec 2025)
- Can be triggered from Intercom, Zendesk, Gong for auto-issue-creation
- Slack Workflow Builder integration
- `AgentSession` entity in the schema:
  ```
  id:          UUID
  status:      AgentSessionStatus
  issueId:     UUID
  commentId:   UUID (nullable)
  appUserId:   UUID (the AI agent's user)
  creatorId:   UUID (who triggered it)
  summary:     String (nullable)
  activities:  [AgentActivity]
  ```

### Duplicate Detection

- Semantic matching across titles, descriptions, customer feedback, support tickets
- Surfaces in Triage flow and as standalone suggestions
- Links issues via `IssueRelation` with type `duplicate`

### AI-Powered Search

- Semantic search beyond keyword matching
- Searches titles, descriptions, customer feedback, support tickets simultaneously
- Available workspace-wide

### Pulse Updates

- AI-distilled summaries of project/initiative updates
- Delivered as daily/weekly email digest or audio format
- Entities: Projects, Initiatives

### MCP Server

Endpoint: `https://mcp.linear.app/mcp` (HTTP Streamable, replaces deprecated `/sse`)

Tools available (confirmed as of Feb 2026):

**Issues**: `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_my_issues`, search with filters
**Projects**: `list_projects`, `get_project`, `create_project`, `update_project`, project health updates
**Cycles**: plan and manage cycles, velocity/burndown tracking
**Teams**: `list_teams`, `get_team`, team member data
**Users**: `list_users`, `get_user`
**Labels**: manage project labels
**Comments**: add markdown comments to issues
**Initiatives**: create and edit (added Feb 2026)
**Initiative Updates**: create and edit (added Feb 2026)
**Project Milestones**: create and edit (added Feb 2026)
**Documents**: create documents
**Project Resources**: manage
**Issue Relations**: manage dependencies
**Images**: load and attach (added Feb 2026)

Authentication: OAuth 2.1 with dynamic client registration OR API key via `Authorization: Bearer <token>`

---

## 20. Entity Relationship Summary

```
Organization (1)
  └─ Teams (N)                        [key: org_id]
       ├─ WorkflowStates (N)          [key: team_id, type category]
       ├─ Cycles (N)                   [key: team_id, number]
       ├─ IssueLabels (N)             [key: team_id or null for workspace]
       └─ Issues (N)                  [key: team_id + sequential number]
            ├─ Comments (N)           [key: issue_id]
            │    └─ Replies (N)       [key: parent_id]
            ├─ Attachments (N)        [key: issue_id]
            ├─ IssueRelations (N)     [key: (issue_id, relatedIssueId, type)]
            └─ Sub-Issues (N)         [key: parent_id → Issue.id]

Projects (N)                          [cross-team, cross-org within workspace]
  ├─ ProjectMilestones (N)
  ├─ ProjectUpdates (N)
  └─ Issues (N)                       [Issue.projectId FK, one project per issue]

Initiatives (N)                       [workspace-level]
  ├─ Sub-Initiatives (N)              [parentInitiativeId FK, up to 5 deep]
  ├─ InitiativeUpdates (N)
  └─ Projects (N via join table)      [many-to-many: InitiativeToProject]

Customers (N)
  └─ CustomerRequests (N)            [linked to Issues]

CustomViews (N)                       [personal/team/workspace scoped]
Documents (N)                         [linked to Projects]
```

### Key cardinalities

| Relationship               | Cardinality  |
|----------------------------|--------------|
| Issue → Team               | N:1 (required) |
| Issue → WorkflowState      | N:1 (required) |
| Issue → Project            | N:1 (optional) |
| Issue → Cycle              | N:1 (optional) |
| Issue → Parent Issue       | N:1 (optional) |
| Issue → Labels             | N:M           |
| Issue → Assignee (User)    | N:1 (optional) |
| Issue → IssueRelations     | 1:N (multiple relations) |
| Project → Teams            | N:M           |
| Project → Milestones       | 1:N           |
| Initiative → Projects      | N:M (join table) |
| Initiative → Parent Init.  | N:1 (optional, up to 5 deep) |
| Team → WorkflowStates      | 1:N           |
| Team → Cycles              | 1:N           |
| Cycle → Issues             | 1:N           |

---

## 21. Pagination Model

All list queries return Relay-style cursor-based pagination:

```graphql
type IssueConnection {
  edges: [IssueEdge!]!
  nodes: [Issue!]!
  pageInfo: PageInfo!
}

type IssueEdge {
  node: Issue!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

Query parameters: `first`, `after`, `last`, `before` (standard Relay).

---

## 22. Webhook Event Types

Webhooks are available for these entities with `create`, `update`, `remove` actions:

- Issues
- Issue Attachments
- Issue Comments
- Issue Labels
- Comment Reactions
- Projects
- Project Updates
- Documents
- Initiatives
- Initiative Updates
- Cycles
- Customers
- Customer Requests
- Users
- Issue SLA (special event)
- OAuthApp revoked (special event)

Payload `updatedFrom` field on update events contains only the previous values of changed fields (delta pattern, not full snapshot).

---

## Research Gaps & Limitations

1. **Complete Team GraphQL type** — could not verify exact field names like `triageEnabled`, `cyclesEnabled` from official SDL; inferred from documentation descriptions.
2. **IssueRelation exact enum strings** — confirmed the four types exist; could not verify if the API uses `blocks`/`blocked`/`related`/`duplicate` vs. other casing.
3. **Custom fields** — Linear has not (as of research date) shipped general-purpose custom fields for Issues the way Notion/Jira have. "Asks fields" exist for CustomerRequest form routing (added June 2025), but general custom fields on Issues are not confirmed.
4. **Full Initiative fields** — `parentInitiative` field confirmed in passing; full SDL not retrieved.
5. **SLA entity fields** — referenced in webhooks/docs but not fully documented here.
6. **Roadmap entity** — referenced in schema file but Linear's "Roadmap" may be a UI concept, not a distinct API entity (distinct from Initiative).
7. **Time tracking** — "Time in Status" added Jan 2026, but the field name and schema placement are not confirmed.

---

## Contradictions Found

1. **Issues and Projects (many-to-many?)**: The conceptual model page implies projects can group issues from multiple teams, which initially suggested many-to-many. The Projects doc page explicitly states "Issues can only be associated with one project at a time" — the relationship is many-to-one from Issue → Project.

2. **Triage state**: Some sources call Triage a "status category" like the others; in practice it is a special opt-in inbox mode that behaves differently (issues excluded from views, special accept/decline/snooze actions).

---

## Search Methodology

- **Searches performed**: 18
- **Key queries**: Linear GraphQL schema, webhook payloads, filter documentation, AI/MCP features, entity-specific docs
- **Most productive terms**: "webhook payload" (concrete field names), "site:linear.app/docs" (official docs), "changelog" (recent additions)
- **Primary source types**: Official Linear docs, Linear changelog, Linear developer/webhook docs, Linear GitHub SDK schema, third-party webhook guide with payload examples

---

## Sources

- [Linear Conceptual Model](https://linear.app/docs/conceptual-model)
- [Linear GraphQL Getting Started](https://linear.app/developers/graphql)
- [Linear Developer Docs](https://linear.app/developers)
- [Linear GraphQL schema (GitHub)](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- [Linear Generated Documents (GitHub)](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.graphql)
- [Apollo Studio Schema Reference](https://studio.apollographql.com/public/Linear-API/schema/reference?variant=current)
- [Issue Workflow / Statuses Docs](https://linear.app/docs/configuring-workflows)
- [Triage Docs](https://linear.app/docs/triage)
- [Triage Intelligence Docs](https://linear.app/docs/triage-intelligence)
- [Parent and Sub-Issues Docs](https://linear.app/docs/parent-and-sub-issues)
- [Issue Relations Docs](https://linear.app/docs/issue-relations)
- [Project Docs](https://linear.app/docs/projects)
- [Project Status Docs](https://linear.app/docs/project-status)
- [Custom Project Statuses Changelog](https://linear.app/changelog/2024-03-19-custom-statuses-for-projects)
- [Priority Docs](https://linear.app/docs/priority)
- [Priority for Projects Changelog](https://linear.app/changelog/2024-07-25-priority-for-projects-and-micro-adjust)
- [Filters Docs](https://linear.app/developers/filtering)
- [Custom Views Docs](https://linear.app/docs/custom-views)
- [Webhooks Docs](https://linear.app/developers/webhooks)
- [Linear Webhook Guide with Payload Examples](https://inventivehq.com/blog/linear-webhooks-guide)
- [Linear AI Features](https://linear.app/ai)
- [Linear Changelog (main)](https://linear.app/changelog)
- [MCP Server Docs](https://linear.app/docs/mcp)
- [MCP Changelog May 2025](https://linear.app/changelog/2025-05-01-mcp)
- [MCP for Product Management Changelog Feb 2026](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management)
- [Auto-Apply Triage Suggestions Changelog](https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions)
- [Customer Requests Docs](https://linear.app/docs/customer-requests)
- [Managing Customers (API)](https://linear.app/developers/managing-customers)
- [Linear API Essentials (Rollout)](https://rollout.com/integration-guides/linear/api-essentials)
- [Linear SDK npm](https://www.npmjs.com/package/@linear/sdk/v/1.6.0)
