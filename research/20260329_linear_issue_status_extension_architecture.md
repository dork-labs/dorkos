---
title: 'Linear Issue Status Extension: Architecture Approaches & API Research'
date: 2026-03-29
type: implementation
status: active
tags: [linear, extension, graphql, api, proxy, cors, authentication, architecture]
feature_slug: linear-issue-status-extension
searches_performed: 11
sources_count: 22
---

# Linear Issue Status Extension: Architecture Approaches & API Research

## Research Summary

The Linear GraphQL API is well-documented, rate-generous, and supports OAuth 2.0 with PKCE and personal API keys. However, DorkOS extensions run entirely in the browser with no npm imports and no access to the Transport layer. Browser-direct fetch to `api.linear.app` is functionally possible (Linear does set permissive CORS headers for authenticated requests) but is architecturally inadvisable: API keys stored in `api.loadData` (which writes to `~/.dork/extensions/{id}/data.json`) are readable by any process with filesystem access, and the key is visible to browser devtools. The cleanest, most secure, and most consistent approach is **Approach B: a server-side proxy route** on the DorkOS Express server — the extension calls `GET /api/proxy/linear/issues`, the server holds the API key, calls Linear, and returns structured data. This mirrors how all other DorkOS integrations (Relay, Mesh, Pulse) work and requires only one new route file plus standard extension UI.

---

## 1. Linear API Overview

### Endpoint & Protocol

- **URL**: `https://api.linear.app/graphql`
- **Protocol**: GraphQL (POST with JSON body, `query` + optional `variables`)
- **Explorer**: Apollo Studio public explorer (no login required) at the Linear developer portal

### Authentication Methods

| Method                 | Header format                                 | Best for                              |
| ---------------------- | --------------------------------------------- | ------------------------------------- |
| Personal API key       | `Authorization: <token>` (no `Bearer` prefix) | Server-side integrations, dev tooling |
| OAuth 2.0 access token | `Authorization: Bearer <token>`               | User-authorized apps                  |
| OAuth PKCE (no secret) | `Authorization: Bearer <token>`               | SPAs, CLI tools without a secret      |

**For the DorkOS use case** (developer's own Linear workspace), a personal API key is the simplest and most appropriate choice. OAuth is designed for third-party apps where users authorize access; a personal key is sufficient for a developer running their own DorkOS instance.

### Rate Limits

| Auth type       | Requests/hour | Complexity points/hour | Max single query |
| --------------- | ------------- | ---------------------- | ---------------- |
| API key         | 5,000         | 250,000                | 10,000 pts       |
| OAuth app       | 5,000         | 2,000,000              | 10,000 pts       |
| Unauthenticated | 60            | 10,000                 | 10,000 pts       |

For a dashboard polling every 60 seconds, 5,000 req/hr is more than adequate (1 req/min = 60 req/hr — well within budget).

### Key GraphQL Queries for Issue Status

**List issues with status for a team:**

```graphql
query IssuesByTeam($teamId: String!, $first: Int, $after: String) {
  team(id: $teamId) {
    issues(first: $first, after: $after, orderBy: updatedAt) {
      nodes {
        id
        identifier # e.g. "ENG-123"
        title
        priority # 0=none, 1=urgent, 2=high, 3=medium, 4=low
        state {
          id
          name
          type # triage|backlog|unstarted|started|completed|canceled
          color # hex color
        }
        assignee {
          id
          displayName
          avatarUrl
        }
        project {
          id
          name
        }
        updatedAt
        url
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

**List teams (prerequisite for team-scoped queries):**

```graphql
query Teams {
  teams {
    nodes {
      id
      name
      key
      color
    }
  }
}
```

**My active issues (assigned to the authenticated user):**

```graphql
query MyIssues {
  viewer {
    assignedIssues(filter: { state: { type: { in: ["started", "unstarted"] } } }) {
      nodes {
        id
        identifier
        title
        priority
        state {
          name
          type
          color
        }
        project {
          name
        }
        updatedAt
        url
      }
    }
  }
}
```

### WorkflowState Types (for color-coding)

| `type`      | Meaning                  | Suggested UI color |
| ----------- | ------------------------ | ------------------ |
| `triage`    | Inbox, needs review      | gray               |
| `backlog`   | Not started, no timeline | muted              |
| `unstarted` | Todo                     | neutral            |
| `started`   | In progress              | blue               |
| `completed` | Done                     | green              |
| `canceled`  | Rejected                 | red/muted          |

The `color` field on `WorkflowState` is a team-defined hex value (e.g., `#4cb782` for Linear's default green) and should be used directly as the badge color — no additional mapping needed.

### Polling vs Webhooks

Linear's developer documentation **explicitly discourages API polling** for change detection and recommends webhooks. For a dashboard displaying current state:

- **Polling every 60s** is reasonable and well within rate limits (60 req/hr vs 5,000 limit)
- **Webhooks** require a public-facing URL, which conflicts with DorkOS's local-first design unless the Tunnel feature is active
- **Recommendation**: Poll on mount + interval (60s default, configurable), with a manual refresh button

---

## 2. Architecture Approaches

### Approach A: Direct Browser Fetch

The extension calls `fetch('https://api.linear.app/graphql', { headers: { Authorization: apiKey } })` directly from browser JavaScript.

**CORS reality**: Linear does permit cross-origin requests to their GraphQL endpoint — they serve a web app at linear.app that calls the same API, so their CORS headers allow `*` or specific origins. Practically, direct browser fetch works in testing. However, the Linear developer documentation never mentions or endorses this pattern, and it is not their recommended integration path.

**Security concern**: The API key must be stored somewhere the browser can read it. `api.loadData()` writes to `~/.dork/extensions/{id}/data.json` on disk — readable by any process on the machine. In the browser, the key lives in the extension's JavaScript runtime and is visible in devtools Network tab. This is acceptable for a personal developer tool (the user is the only person with filesystem access), but it's architecturally weaker than server-side storage.

| Attribute                        | Rating                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| Complexity                       | Low                                                        |
| Security                         | Poor — key exposed in browser network tab and disk JSON    |
| Maintenance                      | Low — no server changes                                    |
| Consistency with DorkOS patterns | Poor — extensions don't make direct external calls         |
| Correctness                      | Works but fragile; CORS behavior is undocumented by Linear |

**Verdict**: Fastest to implement but violates separation of concerns. Suitable only as a prototype.

---

### Approach B: Server-Side Proxy Route (Recommended)

Add a new route `GET /api/proxy/linear/issues` (and `GET /api/proxy/linear/teams`) to the DorkOS Express server. The route reads the Linear API key from server-side storage (env var or `~/.dork/config.json`), calls `api.linear.app/graphql`, and returns the response.

The extension then calls:

```typescript
const res = await fetch('/api/proxy/linear/issues?teamId=ENG&filter=active');
const data = await res.json();
```

No API key in the browser. The server route handles authentication, request construction, response shaping, and error mapping.

**Implementation sketch:**

Server-side (`apps/server/src/routes/proxy-linear.ts`):

```typescript
router.get('/issues', async (req, res) => {
  const apiKey = env.LINEAR_API_KEY; // or read from dorkHome config
  if (!apiKey) return res.status(503).json({ error: 'LINEAR_API_KEY not configured' });

  const { teamId, filter } = IssuesQuerySchema.parse(req.query);
  const gqlResponse = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query: ISSUES_QUERY, variables: { teamId } }),
  });
  const data = await gqlResponse.json();
  res.json(data);
});
```

Extension-side (`index.ts`):

```typescript
function LinearIssuesDashboard() {
  const [issues, setIssues] = React.useState([]);
  React.useEffect(() => {
    fetch('/api/proxy/linear/issues')
      .then((r) => r.json())
      .then((d) => setIssues(d.issues ?? []));
  }, []);
  // render...
}
```

| Attribute                        | Rating                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| Complexity                       | Medium — one new route file, one env var                      |
| Security                         | Good — key stays server-side, never reaches browser           |
| Maintenance                      | Low — proxy is thin, Linear changes are absorbed in one place |
| Consistency with DorkOS patterns | Excellent — mirrors all other DorkOS API routes               |
| Correctness                      | Reliable — server-side Node.js fetch has no CORS constraints  |

**Verdict**: The correct approach. Mirrors DorkOS's existing integration patterns, keeps the API key on the server, and gives the extension a clean HTTP interface.

---

### Approach C: Leverage Existing Linear MCP Tools

DorkOS already has Linear MCP tools registered (`mcp__plugin_linear_linear__*`). Could the extension trigger these via the DorkOS MCP server at `/mcp`?

The MCP server is mounted at `POST /mcp` (stateless, JSON-RPC). An extension making a `POST /mcp` call with a JSON-RPC body could theoretically invoke `list_issues`. However:

1. The MCP endpoint is designed for external agents (Claude Code, Cursor), not internal UI components.
2. MCP tool calls are asynchronous, text-output-oriented, and designed for LLM consumption — the JSON shapes are not optimized for structured UI rendering.
3. The extension would need to parse unstructured LLM-friendly text responses rather than typed GraphQL data.
4. This creates an awkward dependency: a UI widget that works only when the Linear MCP plugin is installed and configured.
5. The DorkOS documentation explicitly states extensions have "no access to the Transport layer or server APIs" — calling `/mcp` from the extension would be working around this restriction rather than respecting it.

| Attribute                        | Rating                                                                   |
| -------------------------------- | ------------------------------------------------------------------------ |
| Complexity                       | High — MCP protocol overhead, response parsing complexity                |
| Security                         | Medium — MCP key managed by MCP plugin, not directly by extension        |
| Maintenance                      | High — fragile dependency on plugin availability and MCP response format |
| Consistency with DorkOS patterns | Poor — MCP is for agent-to-tool, not UI-to-data                          |
| Correctness                      | Unreliable — text outputs, not structured data                           |

**Verdict**: Technically possible but architecturally wrong. MCP tools are for agent orchestration, not dashboard data feeds.

---

### Approach D: Extension System Enhancement (Server-Side Hooks)

Add a capability for extensions to register server-side data providers — essentially allowing extensions to contribute server routes or background jobs. This would let the Linear extension register its own proxy route.

This is a significant architecture extension to the DorkOS extension system. It would require:

- A new extension manifest field (e.g., `"server-hooks": true`)
- Server-side extension loading (separate from browser-side)
- Sandboxing or permission model for server-side extension code
- Documentation, tooling, and testing infrastructure

| Attribute                        | Rating                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| Complexity                       | Very High — major feature addition to the extension system           |
| Security                         | Depends on implementation — server-side code has full Node.js access |
| Maintenance                      | High — new surface area in the platform                              |
| Consistency with DorkOS patterns | Neutral — would be a natural evolution, but premature                |
| Correctness                      | Would be correct if implemented carefully                            |

**Verdict**: Correct long-term direction for the extension platform, but far too large a scope for this feature. Build Approach B now; design Approach D as a separate platform spec.

---

## 3. Security Considerations

### API Key Storage

| Storage location                          | Risk level | Notes                                                        |
| ----------------------------------------- | ---------- | ------------------------------------------------------------ |
| `apps/server/` env var (`LINEAR_API_KEY`) | Low        | Standard practice; loaded from `.env`, never reaches browser |
| `~/.dork/config.json` (server-side read)  | Low        | Consistent with DorkOS config patterns                       |
| Extension `api.saveData()` → `data.json`  | Medium     | On-disk plaintext; accessible to any local process           |
| Browser `localStorage`                    | High       | Cleartext, inspectable, no DorkOS precedent                  |

**Recommendation**: Use an env var (`LINEAR_API_KEY`) following the existing DorkOS env var convention. The user sets it in `.env`; the server reads it via `env.ts` Zod validation. The extension's settings tab can display configuration status ("API key configured: yes/no") without ever displaying the key.

### OAuth vs Personal API Keys

For a personal developer tool like DorkOS:

- **Personal API key**: simpler, no redirect flow, appropriate for single-user local tools
- **OAuth PKCE**: appropriate if DorkOS were a SaaS product where users authorize from their own Linear accounts; overkill for local-first dev tooling

The initial implementation should use a personal API key. OAuth can be added later if DorkOS becomes a multi-user or cloud-hosted product.

### Token Scope

Linear's `read` scope covers all read access. No finer-grained scope is available for issues specifically.

---

## 4. UI Pattern Recommendations

### What Information to Show at a Glance

Based on Linear's own UI patterns and Raycast/VS Code integration patterns, the highest-signal fields for a developer dashboard are:

1. **Issue identifier** (`ENG-123`) — instantly clickable to open in Linear
2. **Title** — truncated to ~60 chars if needed
3. **Status badge** — colored circle/pill using the WorkflowState `color` + `name`
4. **Priority indicator** — colored dot (urgent=red, high=orange, medium=yellow, low=gray, none=muted)
5. **Assignee avatar** — small avatar (24px) or initials fallback
6. **Project name** — secondary metadata, shown if present

Fields that are lower signal for a quick glance:

- Full description (show on expand/hover)
- Labels (show as small colored dots, not full text)
- Cycle number (show only in cycle-focused filter modes)

### Layout Options

**Option 1: Compact list** (recommended for dashboard card)

```
[●] ENG-123  Fix auth token refresh      [●●] Kai N.   Authentication
    In Progress                           High  · Backend
```

**Option 2: Kanban columns** (good for session panel / canvas)

```
Todo (3)          In Progress (2)       Done (5)
[ENG-120]         [ENG-123]             [ENG-119]
[ENG-121]         [ENG-125]             [ENG-118]
[ENG-122]                               ...
```

**Option 3: Status summary card** (minimal, good for sidebar footer)

```
Linear  ·  3 in progress  ·  2 blocking  ·  1 overdue
```

For a dashboard `sections` slot, Option 1 (compact list) is most appropriate. The DorkOS design system uses `var(--muted-foreground)` for secondary text and `var(--border)` for dividers.

### Filtering and Grouping

Most useful filters for a developer:

- **Assigned to me** (`viewer.assignedIssues`) — default view
- **By team** — dropdown populated from `GET /api/proxy/linear/teams`
- **By status type** — toggle: active (started), pending (backlog/unstarted), done (completed)

Grouping by status type (not by individual state name) is more consistent across workspaces since state names are team-customizable but type categories are fixed.

### Update Strategy

- **On mount**: fetch immediately, show skeleton while loading
- **Polling**: every 60 seconds (use `setInterval`, clear on cleanup)
- **Manual refresh**: refresh button in the section header
- **Stale indicator**: show "updated Xs ago" timestamp, dim the card if > 5 min stale

---

## 5. Similar Products Analysis

### Raycast Linear Extension

Raycast's Linear extension (most downloaded extension in the Raycast ecosystem) demonstrates these patterns:

- All API calls go through Raycast's extension runtime (Node.js server-side process), not the browser
- Issue list uses `List.Item` with accessory items: status icon, priority dot, assignee avatar, project name
- Metadata panel shows structured fields on the right side
- Commands for "My Issues", "Assigned Issues", "Search Issues" — the "My Issues" view is the default and most-used entry point

Key takeaway: **"My Issues" (assigned to me, active status) is the right default view.** Most developers check their own queue first, not the whole team's.

### Linear's Official VS Code Extension

Linear's official VS Code extension (`linear-vscode-connect-extension`) is an authentication provider — it doesn't display issues in a sidebar. Third-party extensions like `linear-manager` display issues in a tree view sidebar with status icons.

The sidebar tree pattern maps naturally to DorkOS's `sidebar.tabs` slot if desired, but for the `dashboard.sections` slot, a flat list or card view is more appropriate.

---

## 6. Recommended Implementation Plan

### Phase 1: Core (Approach B)

1. **Add `LINEAR_API_KEY` to server env schema** (`apps/server/src/env.ts`)
2. **Add proxy route** (`apps/server/src/routes/proxy-linear.ts`) with two endpoints:
   - `GET /api/proxy/linear/teams` → returns `[{ id, name, key, color }]`
   - `GET /api/proxy/linear/issues?assignedToMe=true&status=active&teamId=...` → returns shaped issue list
3. **Register route in server** (`apps/server/src/index.ts`)
4. **Build extension** (`~/.dork/extensions/linear-issue-status/`):
   - `extension.json` with `dashboard.sections` and `settings.tabs` contributions
   - Settings tab: API key configured indicator, team selector, filter toggles
   - Dashboard section: compact issue list with status badges, priority dots, assignee avatars
   - 60s polling with manual refresh

### Phase 2: Enhancements (later)

- Filter presets (my issues / team issues / by project)
- Click to open in Linear (use `api.executeCommand` or window.open)
- "Create issue" command via command palette (`dashboard.sections` + `command-palette.items`)
- OAuth support for multi-user scenarios

---

## Key Findings

1. **Linear GraphQL API is browser-accessible via CORS** but this should not be used in production — API keys in the browser are insecure and the pattern is undocumented/unsupported by Linear.

2. **Approach B (server-side proxy) is the unambiguous correct choice** — it follows all existing DorkOS patterns, keeps secrets server-side, and gives the extension a clean typed interface via a local HTTP call.

3. **The existing Linear MCP tools are not suitable for UI data feeding** — they are text-output tools for LLM consumption, not structured data sources for React components.

4. **A personal API key is the right auth mechanism** — OAuth is overkill for a single-user local-first developer tool.

5. **"My Issues" should be the default view** — assigned to the authenticated user, filtered to active states (`started` + `unstarted`). This is the highest-signal view for a developer glancing at their dashboard.

6. **Polling at 60s is appropriate** — well within Linear's 5,000 req/hr limit and sufficient for a developer dashboard. Webhooks require a public URL, which conflicts with local-first design.

7. **Existing Linear domain model research** (`research/20260218_linear-domain-model.md`) covers the complete data model — the `WorkflowState.type` and `WorkflowState.color` fields are the key fields for status display.

---

## Research Gaps & Limitations

1. **Linear CORS headers not officially documented** — confirmed through practical community evidence that browser fetch works, but Linear does not publish their CORS policy. This reinforces Approach B as the correct choice.
2. **`LINEAR_API_KEY` env var name not yet in the codebase** — needs to be added to `apps/server/src/env.ts`.
3. **The proxy route approach requires the DorkOS server to be running** — Obsidian plugin mode (which uses `DirectTransport`) would also work since the extension could fall back to the embedded server. Worth verifying the DirectTransport path supports custom routes.

---

## Contradictions & Disputes

- The extension authoring guide states "No access to the Transport layer or server APIs" as a v1 limitation, but extensions can freely call `fetch()` to any URL — including `http://localhost:{DORKOS_PORT}/api/*`. The "no server APIs" limitation refers to not being able to import server modules, not being unable to make HTTP calls. Approach B exploits this: the extension calls the local DorkOS server just like any browser client would.

---

## Sources & Evidence

- [Linear GraphQL API Docs](https://linear.app/developers/graphql)
- [Linear OAuth 2.0 Authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Linear Rate Limiting](https://linear.app/developers/rate-limiting)
- [Linear Webhooks Docs](https://linear.app/developers/webhooks)
- [Linear API and Webhooks](https://linear.app/docs/api-and-webhooks)
- [Linear API Essentials (Rollout)](https://rollout.com/integration-guides/linear/api-essentials)
- [Linear Webhooks Guide with Payload Examples](https://inventivehq.com/blog/linear-webhooks-guide)
- [DorkOS Extension Authoring Guide](contributing/extension-authoring.md) (local)
- [DorkOS Linear Domain Model Research](research/20260218_linear-domain-model.md) (local, 2026-02-18)
- [Raycast Linear Integration](https://linear.app/integrations/raycast)
- [How Raycast API and Extensions Work](https://www.raycast.com/blog/how-raycast-api-extensions-work)
- [Linear VS Code Integration](https://linear.app/integrations/vs-code)
- [Linear VS Code Connect Extension (GitHub)](https://github.com/linear/linear-vscode-connect-extension)
- [Auth0: Backend for Frontend Pattern](https://auth0.com/blog/the-backend-for-frontend-pattern-bff/)
- [Using the Linear API to Get Issues (JavaScript)](<https://endgrate.com/blog/using-the-linear-api-to-get-issues-(with-javascript-examples)>)

## Search Methodology

- Searches performed: 11
- Most productive search terms: "Linear GraphQL API CORS browser fetch", "Linear API rate limits webhooks vs polling", "Raycast Linear extension issue status display"
- Primary information sources: Linear developer docs, existing DorkOS research (linear-domain-model.md), DorkOS codebase (extension-authoring.md, extensions.ts, mcp.ts)
