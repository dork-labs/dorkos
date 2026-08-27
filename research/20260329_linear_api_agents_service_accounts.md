---
title: 'Linear API: Agents, Service Accounts, and Multi-Agent Issue Assignment'
date: 2026-03-29
type: external-best-practices
status: active
tags: [linear, api, agents, service-accounts, oauth, graphql, multi-agent, assignment, delegation]
searches_performed: 11
sources_count: 18
---

# Linear API: Agents, Service Accounts, and Multi-Agent Issue Assignment

## Research Summary

Linear has a fully-fledged first-party "Agents" system (currently in Developer Preview as of early 2026) that treats AI agents as distinct non-human workspace members. Rather than traditional issue _assignment_, Linear implements _delegation_ — issues stay assigned to humans (who bear accountability) while agents receive delegated work. This distinction is baked into the schema and product philosophy. There is no concept of "assigning" an issue directly to a bot; bots/agents are delegates, not assignees. The OAuth `actor=app` flow creates a dedicated workspace user identity per agent installation, without consuming a billable seat.

---

## Key Findings

### 1. Linear's Agent Model Is First-Class and Purpose-Built

Linear treats agents as proper workspace members with their own user identities, separate from human users. Key properties:

- Agents appear in the workspace as users with their own avatars and display names
- They are surfaced in @mention menus and assignment/delegation menus (if the right OAuth scopes are requested)
- **Agents do not count as billable users** — confirmed by Linear docs
- Agents cannot sign into the app directly, cannot manage other users, and cannot hold admin scope
- Agents are created via the `actor=app` OAuth flow — a dedicated workspace identity is created per installation
- Agents are in Linear's **Developer Preview** as of early 2026

### 2. Assignment vs. Delegation: A Critical Distinction

Linear enforces a philosophical and technical separation:

| Concept      | Who         | Meaning                                             |
| ------------ | ----------- | --------------------------------------------------- |
| **Assignee** | Humans only | Accountable party; responsible for issue completion |
| **Delegate** | Agents only | Action taker; acts on behalf of the human assignee  |

"An agent cannot be held accountable" — Linear's explicit design rationale. So:

- You **cannot** assign an issue to an agent the same way you assign to a human
- When you assign/delegate an issue to an agent via the UI or API, the agent becomes the `delegate`, not the `assignee`
- The human assignee field (`assigneeId`) remains pointing at a human
- The agent is referenced via a separate `delegate` field (an `AgentSession` is created automatically)

**Important behavior note**: A backwards-compatibility shim that mirrored `Issue.delegate` as the `assignee` was removed in 2025. The fields are now strictly separate.

### 3. How to Create an Agent / Service Account (OAuth Actor Flow)

This is the mechanism for creating a "bot user" in Linear:

**Step 1**: Create an Application in Linear Settings (Settings → API → OAuth Applications)

**Step 2**: Enable webhooks and check "Agent session events"

**Step 3**: Initiate OAuth with `actor=app` parameter appended to the authorization URL:

```
https://linear.app/oauth/authorize?
  client_id=YOUR_CLIENT_ID
  &redirect_uri=YOUR_REDIRECT_URI
  &response_type=code
  &scope=read,write,app:assignable,app:mentionable
  &actor=app
```

**Step 4**: Complete OAuth as a workspace admin — this installs the agent into the workspace

**Step 5**: Use the resulting access token to call the API — all mutations performed with this token appear as coming from the "app user" (the agent identity), not a human

**Step 6**: Query the agent's workspace-specific ID:

```graphql
query Me {
  viewer {
    id
  }
}
```

Store this ID alongside the access token — it is unique per workspace installation.

### 4. Required OAuth Scopes for Agents

| Scope                                  | Purpose                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `read`                                 | Base read access                                                                           |
| `write`                                | Base write access                                                                          |
| `app:assignable`                       | Enables agent to appear in delegation/assignment menus; enables receiving delegated issues |
| `app:mentionable`                      | Enables agent to be @mentioned in issues, documents, and editor surfaces                   |
| `customer:read` / `customer:write`     | Access to customer entities (optional)                                                     |
| `initiative:read` / `initiative:write` | Access to initiative entities (optional)                                                   |
| `admin`                                | **NOT ALLOWED** — `actor=app` cannot request admin scope                                   |

The `app:assignable` and `app:mentionable` scopes are opt-in, so existing apps are unaffected by default.

### 5. Agent Identity vs. Human User Identity (User Type Fields)

From the GraphQL schema, the `AgentSession` type includes:

```graphql
type AgentSession implements Node {
  appUser: User!        # The agent's user identity
  creator: User         # The human who triggered the session
  issue: Issue          # The issue being worked
  status: AgentSessionStatus!  # pending | active | error | awaitingInput | complete | stale
  activities(...): AgentActivityConnection!
  context: JSON!
  plan: JSON
  summary: String
  externalLinks: [AgentSessionExternalLink!]!
  # ...timestamps, etc.
}
```

The `appUser` field on `AgentSession` references the agent's identity as a `User` object. The `User` type in the schema (from the 2026-02-18 domain model research) has:

```
id, createdAt, updatedAt, archivedAt, name, displayName, email, avatarUrl, active, admin, isMe
```

Agents created via `actor=app` flow appear in the `users` query results — there is no separate `appUsers` query documented. Query all workspace members:

```graphql
query {
  users {
    nodes {
      id
      name
      displayName
      email # likely empty/synthetic for agents
      active
    }
  }
}
```

### 6. How to Assign/Delegate Issues to Agents via API

**Delegation via `issueUpdate`**: Set `assigneeId` to the agent's user ID. Linear interprets this as delegation (not human assignment) when the target user is an agent identity. The agent becomes the delegate, the issue's `delegate` field is set.

```graphql
mutation IssueUpdate {
  issueUpdate(
    id: "ISSUE-ID"
    input: {
      assigneeId: "AGENT-USER-ID" # The agent's viewer ID from the workspace
    }
  ) {
    success
    issue {
      id
      title
      assignee {
        id
        name
      } # The human assignee (may remain)
    }
  }
}
```

**Issue creation with agent as delegate**:

```graphql
mutation IssueCreate {
  issueCreate(
    input: {
      title: "Task title"
      teamId: "TEAM-ID"
      assigneeId: "AGENT-USER-ID"
      # For actor=app tokens, you can also use:
      createAsUser: "AgentName"
      displayIconUrl: "https://path.to/icon.png"
    }
  ) {
    success
    issue {
      id
      title
    }
  }
}
```

### 7. Agent Session Lifecycle (How Tasks Are "Claimed")

Linear does not have explicit claiming or locking semantics. Instead, session creation serves as the implicit claim signal:

```
Trigger (mention or delegation)
  → AgentSession created automatically by Linear
  → Webhook fired: AgentSessionEvent { action: "created", agentSession: {...} }
  → Agent MUST emit a `thought` activity within 10 seconds (acknowledge)
  → Agent processes work
  → Agent emits activities: thought | action | elicitation | response | error
  → Session auto-transitions through states based on last activity:
     pending → active → awaitingInput / complete / error / stale
```

**Activity mutation**:

```graphql
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { ... }
  }
}
```

**Activity types and their semantic meaning**:

| Type          | Purpose                                                 |
| ------------- | ------------------------------------------------------- |
| `thought`     | Internal reasoning (required within 10s to acknowledge) |
| `action`      | Tool invocation with optional results                   |
| `elicitation` | Request clarification/confirmation from user            |
| `response`    | Completed work or final result                          |
| `error`       | Failure or blocker                                      |

### 8. Multiple Agents Claiming the Same Issue: The Core Problem

**Linear does NOT have native exclusivity/locking for agent delegation.** Key constraints:

- There is no "claim" API call that prevents concurrent delegation
- Multiple agents can technically receive webhooks for the same issue
- Linear does not block assigning/delegating an issue that already has a delegate

**What the community has built to solve this** (from `linear-agent-bridge` by tokezooo):

1. **Deduplication window**: Filter duplicate webhook events within a 5-second window — Linear sometimes fires both an `AgentSession` event and a `Comment` event for the same action
2. **Self-authored filtering**: Skip events from comments created by the agent itself (prevents feedback loops)
3. **Issue state as ownership signal**: Immediately transition the issue to "started" state and set the agent as delegate on session creation — this is a signal (not a lock) that the issue is being worked
4. **Strict addressing mode**: Only process events explicitly addressed to your specific agent (explicit `@mention` or direct delegation), not ambient workspace events
5. **Per-session cryptographic tokens**: Each session gets a unique bearer token scoped to that session, revoked on completion

**The correct DorkOS approach** for preventing multiple Claude Code agents from claiming the same Linear task:

- Use **labels as a state machine**: `agent/ready` → `agent/claimed` → `agent/completed` → `agent/needs-input`
- The claiming operation should be: `issueUpdate(id: ISSUE_ID, input: { assigneeId: AGENT_USER_ID, labelIds: [...existing, CLAIMED_LABEL_ID] })`
- Read-then-write with a tight window — not truly atomic, but in practice sufficient given Linear's webhook-triggered model
- Alternatively, leverage Linear's delegation model: only one agent can be the active delegate per issue — attempting to re-delegate logs it in the activity history

### 9. Listing Users and Identifying Agent Users

```graphql
# List all workspace users
query {
  users {
    nodes {
      id
      name
      displayName
      email
      active
    }
  }
}
```

As of the research date, there is no confirmed `isBot`, `isAgent`, or `isAppUser` boolean on the `User` type in the public schema. Agent users appear in this list alongside humans. The most reliable way to identify your own agent's ID is the `viewer { id }` query executed with the `actor=app` token.

To list workspace apps/integrations, Linear has an `Organization.integrations` or similar query — but this is not part of the documented public surface as clearly as `users`.

### 10. Refresh Token Requirements (Critical for Production)

From October 1, 2025: all new OAuth2 applications have refresh tokens **enabled by default** for user-initiated OAuth with no option to disable.

Applications created before October 1, 2025 must migrate to the refresh token system by **April 1, 2026**.

For `actor=app` installations, the access token lifespan and refresh behavior should be handled accordingly.

---

## Detailed Analysis

### The "Bot User" Question Answered Directly

Linear does not have "bot users" or "service accounts" in the traditional sense (like GitHub bots or Slack bots with email addresses). Instead, they have **app users** — workspace identities created through the `actor=app` OAuth flow. These:

- Have a UUID in the workspace like any user
- Appear in `users` query results
- Can have a display name and avatar icon set at OAuth authorization time
- Do not have a real email address in the traditional sense
- Cannot log into the Linear web app
- Do not consume a billable seat

This is the correct mechanism for DorkOS to use. Each DorkOS instance (or each named Claude Code agent) should ideally have its own `actor=app` OAuth installation, giving it a distinct identity in the workspace.

### The Delegation Model vs. Direct Assignment

The critical insight is that Linear 2025+ **strictly separates** human assignees from agent delegates:

- `issue.assignee` → always a human (or null)
- `issue.delegate` → the agent (app user) working on it

When you call `issueUpdate({ assigneeId: AGENT_ID })`, Linear internally interprets this as setting the delegate field if the target is an app user. The `AgentSession` is created automatically.

This means you cannot use the `assigneeId` field to track _which human_ is responsible when an agent is working the issue — that must be tracked separately or through the pre-delegation state.

### Multi-Agent Claiming Strategy for DorkOS

Given that Linear has no native atomic claim operation, the pragmatic approach is:

1. **Use the `agent/*` label system** (DorkOS already has this): `agent/ready` marks claimable issues. Claiming = atomically-ish updating from `ready` to `claimed` + setting `assigneeId` to the claiming agent's app user ID.

2. **Use the issue `stateId` as a secondary signal**: Move to "In Progress" state (`started` category) as part of the claim operation. Two agents trying to claim concurrently will both succeed at the API level (no DB-level locking), but only one will be "first" and both will record in the activity log.

3. **Accept eventual consistency**: In the Linear-via-webhook model, true atomicity is not available. Design agent claim logic to be idempotent — if an agent receives a session webhook for an issue already being worked by another agent, it should gracefully yield (check the issue's current state/labels before starting work).

4. **Per-agent identity**: Each DorkOS agent registers its own app user via `viewer { id }` at startup. When scanning for `agent/ready` issues, each agent filters for issues assigned to itself (`assigneeId: MY_AGENT_USER_ID`) OR unassigned+labeled `agent/ready`.

---

## Sources & Evidence

- [Linear Agents Getting Started (Developer Preview)](https://linear.app/developers/agents)
- [AI Agents in Linear (User Docs)](https://linear.app/docs/agents-in-linear)
- [OAuth Actor Authorization](https://linear.app/developers/oauth-actor-authorization)
- [OAuth Actor Authorization (Developers)](https://developers.linear.app/docs/oauth/oauth-actor-authorization)
- [Developing the Agent Interaction](https://linear.app/developers/agent-interaction)
- [Linear's Agent SDK Design Blog Post](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)
- [Linear GraphQL Getting Started](https://linear.app/developers/graphql)
- [Assign and Delegate Issues](https://linear.app/docs/assigning-issues)
- [Linear API and Webhooks](https://linear.app/docs/api-and-webhooks)
- [Linear GraphQL Schema (GitHub)](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- [Linear API Graph (Apollo Studio)](https://studio.apollographql.com/public/Linear-API/schema/reference?variant=current)
- [linear-agent-bridge (Community Library)](https://github.com/tokezooo/linear-agent-bridge)
- [How to Build Linear Agents with Hookdeck CLI](https://hookdeck.com/webhooks/platforms/how-to-build-linear-agents-with-hookdeck-cli)
- [Linear Webhooks Complete Guide](https://inventivehq.com/blog/linear-webhooks-guide)
- [Linear for Agents (Product Page)](https://linear.app/agents)
- [Linear Advanced API Usage](https://linear.app/developers/advanced-usage)
- [Linear OAuth 2.0 Authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Linear Developers Portal](https://linear.app/developers)

---

## Research Gaps & Limitations

1. **No confirmed `isBot`/`isAgent` field on `User` type**: The schema (939KB) is too large to fully traverse here. There may be such a field — checking Apollo Studio directly would confirm.
2. **Agent user email format**: Unclear whether `actor=app` installations have a synthetic email or a null/empty email. This matters for filtering users vs. agents in `users` query results.
3. **Atomic claim semantics**: Linear has no documented atomic claim/lock operation. The closest approximation is "first to update wins" — acceptable for low-concurrency scenarios.
4. **Agent session when no human actor**: Linear 2025 added support for creating agent sessions when an issue is delegated with no human actor/assignee — exact webhook payload for this case not fully documented.
5. **`actor=app` token lifetime**: Refresh token specifics for `actor=app` (as opposed to user-initiated OAuth) are not fully documented in accessible sources.
6. **Multiple app users per app**: Whether one OAuth Application can generate multiple distinct agent identities (e.g., one per DorkOS agent slot) is not confirmed — likely each `actor=app` installation is one identity per workspace.

---

## Contradictions & Disputes

1. **Assignment vs. delegation naming**: Some older community resources still describe agents as being "assigned" issues. The 2025 schema change removed the backwards-compat shim — `assignee` and `delegate` are now strictly separate. Any code written before this change may be subtly wrong.
2. **`actor=app` vs. `actor=application`**: Linear docs say `actor=app` supersedes `actor=application`. The older form still works for backward compatibility but new code should use `actor=app`.

---

## Search Methodology

- Searches performed: 11
- Most productive queries: "linear app API bot user agent assignment", "Linear API OAuth actor authorization agents 2025", "Linear agent session webhook app:assignable scope"
- Most productive sources: Linear official developer docs, Linear SDK blog post, linear-agent-bridge community library
- Primary source types: Official Linear developer documentation, Linear changelog, community GitHub repository
