---
description: Debug API and data flow issues by tracing through Component → TanStack Query → Server Action → DAL → Prisma
argument-hint: "[endpoint-or-feature] [--url <url>]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__playwright__browser_snapshot, mcp__playwright__browser_navigate, mcp__playwright__browser_console_messages, mcp__playwright__browser_network_requests, mcp__context7__resolve-library-id, mcp__context7__get-library-docs, mcp__mcp-dev-db__health, mcp__mcp-dev-db__get_schema_overview, mcp__mcp-dev-db__get_table_details, mcp__mcp-dev-db__execute_sql_select, mcp__mcp-dev-db__explain_query, mcp__mcp-dev-db__validate_sql
---

# API & Data Flow Debugging

Debug data-related issues by systematically tracing through the project's data flow layers. This command helps with API failures, data mismatches, stale cache, and server action errors.

## Project Data Flow Architecture

```
┌─────────────────┐
│  React Component │  ← UI displays data
├─────────────────┤
│  TanStack Query  │  ← Client-side caching & fetching
├─────────────────┤
│  API Route (GET) │  ← HTTP endpoint for reads
│  Server Action   │  ← Direct calls for mutations
├─────────────────┤
│  DAL (entities/) │  ← Data Access Layer with auth
├─────────────────┤
│  Prisma Client   │  ← Database ORM
├─────────────────┤
│  PostgreSQL      │  ← Neon database
└─────────────────┘
```

## Arguments

Parse `$ARGUMENTS`:
- If `--url <url>` flag provided, navigate to that URL
- Remaining text describes the endpoint or feature with issues
- If empty, prompt for details

## Phase 1: Issue Identification

### 1.1 Gather Information

If no description provided:

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
    - label: "Server action failing"
      description: "Mutation/form submission not working"
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
    - label: "API Route"
      description: "HTTP endpoint returning wrong data"
    - label: "Server Action"
      description: "Mutation not working correctly"
    - label: "Database"
      description: "Data in DB is wrong or query is incorrect"
    - label: "Not sure"
      description: "Need help identifying the layer"
```

### 1.3 Get Timing Context

```
AskUserQuestion:
  question: "When did this issue start?"
  header: "Timeline"
  options:
    - label: "After recent code changes"
      description: "Started after modifying code"
    - label: "After database changes"
      description: "Started after schema migration or data update"
    - label: "Intermittent"
      description: "Happens sometimes, not always"
    - label: "Always"
      description: "Never worked correctly"
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
# Get latest dev server log
LATEST_LOG=$(ls -t .logs/ 2>/dev/null | head -1)
if [ -n "$LATEST_LOG" ]; then
  echo "=== Recent Server Logs ==="
  grep -E "error|failed|POST|GET|prisma" ".logs/$LATEST_LOG" | tail -30
fi
```

### 2.3 Identify the Data Path

Based on the feature, trace the data flow:

1. **Find the component** displaying/mutating the data
2. **Find the TanStack Query hook** or server action call
3. **Find the API route** (for queries) or server action (for mutations)
4. **Find the DAL function** in `entities/*/api/`
5. **Find the Prisma query** in the DAL function

## Phase 3: Parallel Layer Investigation

When the issue layer is unclear, launch parallel diagnostic agents to investigate multiple layers simultaneously.

### 3.0 Launch Parallel Diagnostics (Optional)

If user selected "Not sure" for problem layer, run diagnostics in parallel:

```
# Launch all diagnostic agents simultaneously
component_agent = Task(
  description: "Trace component data flow",
  prompt: """
    Investigate the frontend layer for the data issue.

    1. Find React components displaying the affected data
    2. Check how data is being fetched (useQuery, server action)
    3. Look for rendering conditions that might hide data
    4. Check error boundaries and loading states
    5. Verify data shape matches expected interface

    Return findings in this format:
    ## Component Layer Findings
    **Component**: [file path]
    **Data Source**: [useQuery/server action/props]
    **Issue Found**: [Yes/No]
    **Details**: [explanation]
    **Confidence**: [High/Medium/Low]
  """,
  subagent_type: "react-tanstack-expert",
  run_in_background: true
)

action_agent = Task(
  description: "Check server actions and API routes",
  prompt: """
    Investigate the server action/API layer for the data issue.

    1. Find the server action or API route handling this data
    2. Check for 'use server' directive and proper exports
    3. Verify Zod validation passes
    4. Check revalidatePath/revalidateTag calls
    5. Look for error handling issues

    Return findings in this format:
    ## Server Action Layer Findings
    **File**: [file path]
    **Function**: [function name]
    **Issue Found**: [Yes/No]
    **Details**: [explanation]
    **Confidence**: [High/Medium/Low]
  """,
  subagent_type: "general-purpose",
  run_in_background: true
)

dal_agent = Task(
  description: "Check DAL and database queries",
  prompt: """
    Investigate the DAL and database layer for the data issue.

    1. Find the DAL function in entities/*/api/
    2. Check auth (getCurrentUser/requireAuth)
    3. Verify Prisma query is correct
    4. Check include/select clauses
    5. Look for proper error handling

    Return findings in this format:
    ## DAL Layer Findings
    **File**: [file path]
    **Function**: [function name]
    **Issue Found**: [Yes/No]
    **Details**: [explanation]
    **Confidence**: [High/Medium/Low]
  """,
  subagent_type: "prisma-expert",
  run_in_background: true
)

# Display progress
print("🔍 Running parallel diagnostics across all layers...")
print("   → Component layer investigation")
print("   → Server action/API layer investigation")
print("   → DAL/Database layer investigation")

# Collect results
component_result = TaskOutput(task_id: component_agent.id, block: true)
print("   ✅ Component layer complete")

action_result = TaskOutput(task_id: action_agent.id, block: true)
print("   ✅ Server action layer complete")

dal_result = TaskOutput(task_id: dal_agent.id, block: true)
print("   ✅ DAL layer complete")

# Synthesize findings
print("\n📊 Diagnostic Summary:")
# Present findings from each layer, highlight where issues were found
```

**Benefits**:
- 3x faster than sequential investigation
- Each agent uses specialized expertise
- Parallel context usage instead of single overloaded context

### 3.1 Frontend Layer

Check the React component:

```
Read the component file.
Look for:
- How is data being fetched? (useQuery, server action)
- How is data being displayed?
- Are there conditional renders that might hide data?
- Is there error handling?
```

Questions to ask:
- Is the component receiving the data?
- Is the data in the expected shape?
- Are there rendering conditions blocking display?

### 3.2 TanStack Query Layer

Check the query configuration:

```
Read the query hook file.
Look for:
- queryKey: Is it unique and correct?
- queryFn: Is it calling the right endpoint?
- staleTime: Is caching too aggressive?
- enabled: Is the query enabled when it should be?
- select: Is data being transformed correctly?
```

Common TanStack Query issues:

| Issue | Symptom | Fix |
|-------|---------|-----|
| Stale data | Old data after mutation | Invalidate queries after mutation |
| Cache key collision | Wrong data displayed | Make queryKey more specific |
| Query disabled | No fetch occurs | Check `enabled` condition |
| Infinite loading | Never resolves | Check queryFn for errors |

### 3.3 API Route Layer (GET requests)

Check the route handler:

```
Read the API route file in src/app/api/.
Look for:
- Is auth being checked?
- Is the DAL function being called correctly?
- Is the response format correct?
- Are errors being handled?
```

### 3.4 Server Action Layer (Mutations)

Check the server action:

```
Read the server action file.
Look for:
- 'use server' directive present?
- Input validation with Zod?
- DAL function being called?
- revalidatePath/revalidateTag after mutation?
- Error handling and return format?
```

Common server action issues:

| Issue | Symptom | Fix |
|-------|---------|-----|
| Missing revalidation | Data stale after mutation | Add `revalidatePath()` |
| Validation failure | Action returns error | Check Zod schema matches input |
| Auth failure | 401/403 errors | Check `requireAuth()` call |
| Silent failure | No response | Check return statement |

### 3.5 DAL Layer

Check the Data Access Layer function:

```
Read the DAL file in src/layers/entities/*/api/.
Look for:
- Auth check (getCurrentUser/requireAuth)?
- Correct Prisma query?
- Proper error handling?
- Return type matches expected?
```

### 3.6 Prisma Layer

Check the database query:

```
Read the Prisma query in the DAL.
Look for:
- Correct model being queried?
- Where clause correct?
- Include/select covering needed fields?
- Sorting/pagination correct?
```

### 3.7 Database Layer (Direct Verification)

Use MCP database tools to verify actual data state:

```
# Check if MCP database server is available
mcp__mcp-dev-db__health: {}

# Get table structure and sample data
mcp__mcp-dev-db__get_table_details: { table: "[table_name]" }

# Query actual data
mcp__mcp-dev-db__execute_sql_select: {
  sql: "SELECT * FROM [table] WHERE [condition] LIMIT 10"
}
```

This is the **ground truth** - if data exists here but not in the UI, the issue is in the application layers above.

Key checks:
- Does the record exist in the database?
- Are foreign key relationships intact?
- Are timestamps correct (created_at, updated_at)?
- Are nullable fields unexpectedly NULL?

**Note**: Requires `MCP_DEV_ONLY_DB_ACCESS=true` in `.env.local`

## Phase 4: Specific Debugging Scenarios

### 4.1 Data Not Loading

Debugging checklist:
1. [ ] Check network tab for request
2. [ ] Check server logs for errors
3. [ ] Verify API route exists and handles GET
4. [ ] Check DAL function returns data
5. [ ] Verify Prisma query finds records
6. [ ] Check TanStack Query is enabled

### 4.2 Stale Data After Mutation

Debugging checklist:
1. [ ] Check server action calls `revalidatePath()` or `revalidateTag()`
2. [ ] Verify TanStack Query invalidation: `queryClient.invalidateQueries()`
3. [ ] Check queryKey matches between query and invalidation
4. [ ] Verify mutation is actually succeeding

### 4.3 Wrong Data Shape

```
AskUserQuestion:
  question: "Where is the data shape mismatch?"
  header: "Shape Issue"
  options:
    - label: "API returns wrong shape"
      description: "Response doesn't match expected interface"
    - label: "Prisma returns wrong shape"
      description: "Database query missing fields"
    - label: "Transform issue"
      description: "Data is being incorrectly transformed"
    - label: "Type mismatch"
      description: "TypeScript types don't match actual data"
```

### 4.4 API Errors

Check error details:
```
mcp__playwright__browser_network_requests: { includeStatic: false }
```

Common API errors:

| Status | Meaning | Check |
|--------|---------|-------|
| 400 | Bad Request | Request body/params validation |
| 401 | Unauthorized | Auth token/session |
| 403 | Forbidden | User permissions |
| 404 | Not Found | Route exists, resource ID |
| 500 | Server Error | Server logs, Prisma errors |

## Phase 5: Fix Implementation

### 5.1 Confirm Fix Approach

```
AskUserQuestion:
  question: "Based on my analysis, the issue is at the [LAYER] layer. How should we proceed?"
  header: "Fix Approach"
  options:
    - label: "Fix the identified issue"
      description: "Implement the fix I described"
    - label: "Investigate more"
      description: "I want to understand the issue better first"
    - label: "Different approach"
      description: "I have a different idea for the fix"
```

### 5.2 Plan the Fix

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

### 5.3 Make Changes

For each change:
1. **Read the file first**
2. **Make targeted edits**
3. **Follow project DAL patterns** - auth checks, error handling
4. **Add cache invalidation** if mutation

### 5.4 Verify the Fix

If browser URL provided:
```
mcp__playwright__browser_navigate: { url: "[url]" }
mcp__playwright__browser_snapshot: {}
mcp__playwright__browser_network_requests: { includeStatic: false }
```

Check:
- Data loads correctly
- No console errors
- Network requests succeed

## Phase 6: Wrap-Up

### 6.1 Summarize

```markdown
## Data Issue Resolved

**Problem**: [Original issue description]
**Layer**: [Where the bug was - Component/Query/API/DAL/Prisma]
**Root Cause**: [Why the issue occurred]
**Solution**: [What was changed]
**Files Modified**: [List of files]
```

### 6.2 Cache Considerations

If caching was involved, note:
- What cache invalidation was added
- What staleTime/cacheTime settings apply
- When data will refresh

### 6.3 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Test another scenario"
      description: "Verify data flow in different conditions"
    - label: "Check related endpoints"
      description: "Debug similar data issues"
    - label: "Add error handling"
      description: "Improve error handling in this flow"
    - label: "Commit the fix"
      description: "Run /git:commit to save changes"
    - label: "Done"
      description: "I'm satisfied with the fix"
```

## Quick Reference

### Project File Locations

| Layer | Location |
|-------|----------|
| Components | `src/layers/features/*/ui/` or `src/layers/widgets/*/` |
| TanStack Query | `src/layers/features/*/model/` |
| API Routes | `src/app/api/*/route.ts` |
| Server Actions | `src/app/actions/` or `src/layers/features/*/api/` |
| DAL Queries | `src/layers/entities/*/api/queries.ts` |
| DAL Mutations | `src/layers/entities/*/api/mutations.ts` |
| Prisma Schema | `prisma/schema.prisma` |

### TanStack Query Patterns

```typescript
// Invalidate after mutation
queryClient.invalidateQueries({ queryKey: ['accounts'] })

// Optimistic update
onMutate: async (newData) => {
  await queryClient.cancelQueries({ queryKey })
  const previous = queryClient.getQueryData(queryKey)
  queryClient.setQueryData(queryKey, newData)
  return { previous }
}
```

### Server Action Patterns

```typescript
'use server'
import { revalidatePath } from 'next/cache'

export async function createItem(data: FormData) {
  const validated = schema.safeParse(Object.fromEntries(data))
  if (!validated.success) return { error: validated.error }

  const result = await createItemDAL(validated.data)
  revalidatePath('/items')  // Don't forget this!
  return result
}
```

## Important Behaviors

1. **ALWAYS** trace through all layers before fixing
2. **CHECK** server logs for errors
3. **VERIFY** data exists in database (Prisma Studio)
4. **ENSURE** cache invalidation after mutations
5. **FOLLOW** project DAL patterns - never call Prisma directly
6. **TEST** both success and error states

## Edge Cases

- **Race conditions**: Multiple concurrent requests
- **Optimistic updates**: Rollback on failure
- **Pagination**: Cursor vs offset issues
- **Relationships**: Include clauses for nested data
- **Soft deletes**: Check for deleted records being returned
