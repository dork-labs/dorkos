---
description: Debug API and data flow issues by tracing through Component -> TanStack Query -> Express Route -> Service -> SQLite/JSONL
argument-hint: '[endpoint-or-feature] [--url <url>]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__playwright__browser_snapshot, mcp__playwright__browser_navigate, mcp__playwright__browser_console_messages, mcp__playwright__browser_network_requests, mcp__context7__resolve-library-id, mcp__context7__query-docs
---

# API & Data Flow Debugging

Debug data-related issues by systematically tracing through the project's data flow layers. This command helps with API failures, data mismatches, stale cache, and service errors.

## Project Data Flow Architecture

```
+-------------------+
|  React Component  |  <- UI displays data (FSD layers)
+-------------------+
|  TanStack Query   |  <- Client-side caching & fetching
+-------------------+
|  Transport Layer  |  <- HttpTransport (REST/SSE) or DirectTransport (Obsidian)
+-------------------+
|  Express Route    |  <- HTTP endpoints (Zod validation, boundary checks)
+-------------------+
|  Service Layer    |  <- Business logic (agent-manager, binding-router, etc.)
+-------------------+
|  Data Store       |  <- SQLite (dork.db) + JSONL transcripts + JSON state files
+-------------------+
```

### Key Differences from Typical Projects

- **No Prisma/PostgreSQL** — Uses SQLite (better-sqlite3, WAL mode) and JSON files
- **No server actions** — All mutations go through Express REST endpoints
- **Transport abstraction** — Client uses `Transport` interface, not direct fetch
- **SDK transcripts** — Sessions are derived from JSONL files on disk, not a database
- **Feature-flag guarded** — Relay/Mesh/Pulse endpoints return 503 when disabled

## Arguments

Parse `$ARGUMENTS`:

- If `--url <url>` flag provided, navigate to that URL
- Remaining text describes the endpoint or feature with issues
- If empty, prompt for details

## Phase 1: Issue Identification

### 1.1 Gather Information

```
AskUserQuestion:
  question: "What kind of data issue are you experiencing?"
  header: "Issue Type"
  options:
    - label: "Wrong data displayed"
      description: "UI shows incorrect or unexpected data"
    - label: "Data not loading"
      description: "Loading state never resolves, no data appears"
    - label: "Stale data"
      description: "Data doesn't update after changes"
    - label: "API error"
      description: "Getting error responses from the server"
    - label: "Relay/Mesh/Pulse issue"
      description: "Subsystem-specific data problem"
```

### 1.2 Identify the Layer

```
AskUserQuestion:
  question: "Where do you think the issue is occurring?"
  header: "Problem Layer"
  options:
    - label: "Frontend/UI"
      description: "Component not rendering data correctly"
    - label: "TanStack Query"
      description: "Caching, refetching, or query issues"
    - label: "Express Route"
      description: "HTTP endpoint returning wrong data or errors"
    - label: "Service Layer"
      description: "Business logic or data processing issue"
    - label: "Data Store"
      description: "SQLite, JSONL, or JSON file has wrong data"
    - label: "Not sure"
      description: "Need help identifying the layer"
```

## Phase 2: Initial Assessment

### 2.1 Check Browser State (if URL provided)

```
mcp__playwright__browser_navigate: { url: "[provided-url]" }
mcp__playwright__browser_snapshot: {}
mcp__playwright__browser_console_messages: { level: "error" }
mcp__playwright__browser_network_requests: { includeStatic: false }
```

### 2.2 Check Server Logs

```bash
DORK_HOME="apps/server/.temp/.dork"
LOG="$DORK_HOME/logs/dorkos.log"

# Recent errors and warnings (NDJSON format)
tail -200 "$LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('level', 0) >= 40:
            print(f\"[{obj.get('time','')}] {obj.get('msg','')}\"[:200])
    except: pass
" | tail -20
```

### 2.3 Identify the Data Path

Based on the feature, trace the data flow:

1. **Find the component** displaying/mutating the data (FSD layer structure)
2. **Find the TanStack Query hook** in `entities/*/model/` or `features/*/model/`
3. **Find the Express route** in `apps/server/src/routes/`
4. **Find the service** in `apps/server/src/services/`
5. **Find the data store** (SQLite table, JSONL file, or JSON state file)

## Phase 3: Layer Investigation

### 3.1 Frontend Layer

```
Read the component file.
Look for:
- How is data being fetched? (useQuery hook from entities/)
- How is data being displayed?
- Are there conditional renders that might hide data?
- Is there error handling?
- Does the Transport context provide the right transport?
```

### 3.2 TanStack Query Layer

```
Read the query hook file in entities/*/model/.
Look for:
- queryKey: Is it unique and correct?
- queryFn: Does it call the right transport method?
- staleTime: Is caching too aggressive?
- enabled: Is the query enabled when it should be?
- select: Is data being transformed correctly?
```

Common TanStack Query issues:

| Issue                | Symptom                 | Fix                                   |
| -------------------- | ----------------------- | ------------------------------------- |
| Stale data           | Old data after mutation | Invalidate queries after mutation     |
| Cache key collision  | Wrong data displayed    | Make queryKey more specific           |
| Query disabled       | No fetch occurs         | Check `enabled` condition             |
| Infinite loading     | Never resolves          | Check queryFn for errors              |
| Missing invalidation | Data stale after action | Add `queryClient.invalidateQueries()` |

### 3.3 Express Route Layer

```
Read the route file in apps/server/src/routes/.
Look for:
- Is Zod validation passing? (schema.safeParse)
- Is the boundary check passing? (validateBoundary)
- Is the feature flag enabled? (isRelayEnabled, isMeshEnabled)
- Is the service being called correctly?
- Is the response format correct?
```

Key route files:

| Route File           | Endpoints                             |
| -------------------- | ------------------------------------- |
| `routes/sessions.ts` | Session CRUD, SSE streaming, messages |
| `routes/relay.ts`    | Relay messaging, adapters, bindings   |
| `routes/mesh.ts`     | Mesh discovery, agents, topology      |
| `routes/pulse.ts`    | Schedules, runs, triggers             |
| `routes/agents.ts`   | Agent identity CRUD                   |
| `routes/config.ts`   | Server configuration                  |

### 3.4 Service Layer

```
Read the service file.
Look for:
- Is data being read/written correctly?
- Are errors being handled and propagated?
- Is the service properly initialized?
- Are dependencies injected correctly?
```

### 3.5 Data Store Layer (Ground Truth)

Check actual data in SQLite and state files:

```bash
DORK_HOME="apps/server/.temp/.dork"

# SQLite queries for common data
sqlite3 -header -column "$DORK_HOME/dork.db" "SELECT * FROM [table] LIMIT 10;"

# Relay state files
cat "$DORK_HOME/relay/adapters.json" | python3 -m json.tool
cat "$DORK_HOME/relay/bindings.json" | python3 -m json.tool

# Server config
cat "$DORK_HOME/config.json" | python3 -m json.tool
```

For session data, check SDK transcripts:

```bash
# List recent session transcripts
ls -lt ~/.claude/projects/*/  2>/dev/null | head -10
```

This establishes **ground truth**:

- If data exists in DB/files but not in UI -> Issue is in application layers
- If data missing from store -> Issue is in write operation
- If data is wrong in store -> Issue is in mutation logic

## Phase 4: Specific Debugging Scenarios

### 4.1 Data Not Loading

Debugging checklist:

1. [ ] Check network tab for request (is it being made?)
2. [ ] Check server logs for errors (NDJSON in `.dork/logs/`)
3. [ ] Verify Express route exists and handles the request method
4. [ ] Check feature flag is enabled (relay, mesh, pulse)
5. [ ] Verify service returns data
6. [ ] Check TanStack Query is enabled

### 4.2 Stale Data After Mutation

Debugging checklist:

1. [ ] Check mutation endpoint returns success
2. [ ] Verify TanStack Query invalidation: `queryClient.invalidateQueries()`
3. [ ] Check queryKey matches between query and invalidation
4. [ ] Look for `onSuccess` callbacks that invalidate related queries
5. [ ] Check if data is cached in Zustand store instead of TanStack Query

### 4.3 Feature Returns 503

This means the feature flag is disabled:

```bash
DORK_HOME="apps/server/.temp/.dork"

# Check which features are enabled
cat "$DORK_HOME/config.json" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
print(f\"Relay: {cfg.get('relay', {}).get('enabled', False)}\")
print(f\"Pulse: {cfg.get('scheduler', {}).get('enabled', False)}\")
print(f\"Mesh: {cfg.get('mesh', {}).get('enabled', False)}\")
"
```

### 4.4 API Returns 403

Boundary violation — the requested path is outside the configured boundary:

```bash
# Check boundary setting
cat "$DORK_HOME/config.json" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
print(f\"Boundary: {cfg.get('server', {}).get('boundary', 'default (home dir)')}\")
"
```

### 4.5 Session Lock (409)

Another client has the session locked:

```bash
# Check server logs for lock information
tail -100 "$DORK_HOME/logs/dorkos.log" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if 'lock' in obj.get('msg', '').lower():
            print(json.dumps(obj, indent=2))
    except: pass
"
```

## Phase 5: Fix Implementation

### 5.1 Plan the Fix

```
TodoWrite:
  todos:
    - content: "Trace data flow to identify issue layer"
      activeForm: "Tracing data flow"
      status: "completed"
    - content: "Implement fix at [specific layer]"
      activeForm: "Implementing fix"
      status: "pending"
    - content: "Verify data loads correctly"
      activeForm: "Verifying fix"
      status: "pending"
```

### 5.2 Verify the Fix

```bash
# Check server logs for new errors
tail -20 "$DORK_HOME/logs/dorkos.log" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('level', 0) >= 40:
            print(json.dumps(obj, indent=2))
    except: pass
"
```

If browser URL provided:

```
mcp__playwright__browser_navigate: { url: "[url]" }
mcp__playwright__browser_snapshot: {}
mcp__playwright__browser_network_requests: { includeStatic: false }
```

## Phase 6: Wrap-Up

```markdown
## Data Issue Resolved

**Problem**: [Original issue description]
**Layer**: [Where the bug was — Component/Query/Route/Service/Store]
**Root Cause**: [Why the issue occurred]
**Solution**: [What was changed]
**Files Modified**: [List of files]
```

## Quick Reference

### Project File Locations

| Layer                | Location                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Components           | `apps/client/src/layers/features/*/ui/`                                 |
| TanStack Query hooks | `apps/client/src/layers/entities/*/model/`                              |
| Zustand store        | `apps/client/src/layers/shared/model/app-store.ts`                      |
| Transport interface  | `packages/shared/src/transport.ts`                                      |
| Express routes       | `apps/server/src/routes/`                                               |
| Services             | `apps/server/src/services/`                                             |
| Zod schemas          | `packages/shared/src/schemas.ts`, `relay-schemas.ts`, `mesh-schemas.ts` |
| SQLite DB            | `{DORK_HOME}/dork.db`                                                   |
| Session transcripts  | `~/.claude/projects/{slug}/*.jsonl`                                     |
| Relay state          | `{DORK_HOME}/relay/`                                                    |
| Server config        | `{DORK_HOME}/config.json`                                               |
| Server logs          | `{DORK_HOME}/logs/dorkos.log`                                           |

### Common Express Route Patterns

```typescript
// Zod validation
const parsed = Schema.safeParse(req.body);
if (!parsed.success)
  return res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });

// Boundary check
if (!validateBoundary(req.body.path))
  return res.status(403).json({ error: 'Path outside boundary' });

// Feature flag guard
if (!isRelayEnabled()) return res.status(503).json({ error: 'Relay is not enabled' });
```

### TanStack Query Patterns

```typescript
// Invalidate after mutation
queryClient.invalidateQueries({ queryKey: ['sessions'] });

// Check if query is fetching
const { data, isLoading, error } = useQuery({ queryKey: ['key'], queryFn: fn });
```

## Important Behaviors

1. **ALWAYS** trace through all layers before fixing
2. **CHECK** server logs (NDJSON in `.dork/logs/`) for errors
3. **VERIFY** data exists in data store (SQLite, JSON files, JSONL)
4. **ENSURE** TanStack Query invalidation after mutations
5. **CHECK** feature flags before investigating subsystem routes
6. **TEST** both success and error states
