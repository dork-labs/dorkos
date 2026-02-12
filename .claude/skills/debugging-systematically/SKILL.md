---
name: debugging-systematically
description: Guides systematic debugging methodology and troubleshooting approaches. Use when investigating bugs, tracing issues, or teaching debugging patterns.
---

# Debugging Systematically

This skill provides **debugging methodology** — systematic approaches to finding and fixing bugs. It covers the mental models and techniques for effective troubleshooting.

**For specific debugging tools**: See `/debug:*` commands.

## Core Debugging Methodology

### The Scientific Method for Bugs

1. **Observe** — What is actually happening?
2. **Hypothesize** — What could cause this?
3. **Test** — Design an experiment to verify
4. **Analyze** — Did the test confirm or refute?
5. **Iterate** — Refine hypothesis and repeat

### The Golden Rule

> **Understand before you fix.**

Never make changes to code you don't understand. Reading and comprehending the code often reveals the bug.

## Problem Articulation

### Questions to Answer First

| Question | Why It Matters |
|----------|----------------|
| What should happen? | Defines the expected behavior |
| What actually happens? | Identifies the discrepancy |
| When did it start? | Narrows the scope of changes |
| What changed recently? | Identifies potential causes |
| Is it reproducible? | Determines debugging approach |

### Rubber Duck Method

The act of explaining code line-by-line forces you to:
- Think through logic sequentially
- Surface implicit assumptions
- Notice gaps in understanding
- Catch inconsistencies

**Often, the solution becomes obvious mid-explanation.**

## Hypothesis Formation

### Common Bug Categories

| Category | Symptoms | Check |
|----------|----------|-------|
| **Data** | Wrong values, undefined | Log actual values |
| **Logic** | Wrong branch, off-by-one | Trace conditionals |
| **Timing** | Race conditions, stale data | Check async flow |
| **State** | Inconsistent behavior | Inspect state at each step |
| **Integration** | API mismatches | Verify contracts |

### Ranking Hypotheses

Test hypotheses in order of:
1. **Likelihood** — Most common causes first
2. **Ease of testing** — Quick tests before complex ones
3. **Impact** — High-impact issues take priority

## Investigation Techniques

### Binary Search Debugging

When you don't know where the bug is:

1. Identify start point (known good) and end point (known bad)
2. Check the midpoint
3. If midpoint is good, bug is in second half
4. If midpoint is bad, bug is in first half
5. Repeat until isolated

### Data Flow Tracing

For data issues, trace the complete path:

```
Input → Transform → Store → Retrieve → Transform → Output
  ↓         ↓          ↓         ↓          ↓         ↓
Verify   Verify     Verify   Verify     Verify    Verify
```

Log at each step to find where data diverges from expected.

### Isolation Technique

When facing complex bugs:

1. **Remove variables** — Simplify to minimal reproduction
2. **Mock dependencies** — Eliminate external factors
3. **Hardcode values** — Remove dynamic inputs
4. **Comment out code** — Find which section causes issue

### Reproducing First

**Never try to fix a bug you can't reproduce.**

Steps to reproduce:
1. Document exact steps
2. Note environment (browser, OS, data state)
3. Identify minimum case
4. Create automated reproduction if possible

## Layer-by-Layer Debugging

### Project Data Flow

```
Component → TanStack Query → API Route → DAL → Prisma → Database
```

Debug from the outside in or inside out:

**Outside-in** (start at symptom):
- User sees wrong data
- Check component receives correct data
- Check query returns correct data
- Check API returns correct data
- Check DAL returns correct data
- Check database has correct data

**Inside-out** (start at source):
- Verify database has correct data (use MCP database tools)
- Verify DAL query is correct
- Verify API transforms correctly
- Verify query caches correctly
- Verify component renders correctly

### Layer-Specific Checks

| Layer | What to Check | Tools |
|-------|---------------|-------|
| Component | Props received, render conditions, state | Browser DevTools |
| TanStack Query | Cache key, staleTime, enabled, queryFn | React Query Devtools |
| API Route | Auth, request parsing, response format | Network tab, logs |
| DAL | Auth check, Prisma query, error handling | Server logs |
| Prisma | Query syntax, includes, where clauses | Logs, explain |
| Database | Data exists, correct values, relationships | **MCP database tools** |

### Database Verification (Ground Truth)

When debugging data issues, verify the **actual database state** using MCP tools:

```
mcp__mcp-dev-db__get_table_details: { table: "[table_name]" }
mcp__mcp-dev-db__execute_sql_select: { sql: "SELECT * FROM [table] WHERE [condition] LIMIT 10" }
```

This establishes **ground truth**:
- If data exists in DB but not in UI → Issue is in application layers
- If data missing from DB → Issue is in write operation
- If data is wrong in DB → Issue is in mutation logic

**Requires**: `MCP_DEV_ONLY_DB_ACCESS=true` in `.env.local`

## Common Bug Patterns

### JavaScript/TypeScript

| Pattern | Example | Fix |
|---------|---------|-----|
| Implicit coercion | `"5" + 3 = "53"` | Explicit conversion |
| Async not awaited | Missing `await` | Add await, check Promise |
| Closure capture | Loop variable captured | Use let, not var |
| Null/undefined access | `obj.prop` when obj is null | Optional chaining `?.` |
| Reference vs value | Object mutation | Spread or clone |

### React

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Stale closure | Old state in callback | Use callback form or ref |
| Missing dependency | Effect doesn't re-run | Add to dependency array |
| Infinite loop | Component re-renders forever | Check useEffect deps |
| Key issues | List items behave wrong | Use unique, stable keys |
| Server/client mismatch | Hydration errors | Check where state initializes |

### Data Fetching

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Stale cache | Old data after mutation | Invalidate queries |
| Race condition | Wrong data displayed | Cancel previous requests |
| N+1 queries | Slow loading | Use include/eager loading |
| Missing error handling | Silent failures | Add try/catch, onError |

## Debugging Tools

### Console Methods

```javascript
console.log()           // Basic output
console.table()         // Tabular data
console.group()         // Grouped output
console.time()          // Performance timing
console.trace()         // Stack trace
console.assert()        // Conditional logging
```

### Strategic Logging

```javascript
// Tag logs for filtering
console.log('[AUTH]', user)
console.log('[DATA]', response)

// Log with context
console.log('[API] Request:', { endpoint, params, timestamp: Date.now() })

// Remove before commit (or use debug library)
```

### Debugger Usage

```javascript
// Break at specific point
debugger;

// Conditional break
if (someCondition) debugger;
```

### Browser DevTools

| Tab | Use For |
|-----|---------|
| Console | Errors, logs, REPL |
| Network | API calls, timing, payloads |
| Elements | DOM inspection, styles |
| Sources | Breakpoints, stepping |
| Application | Storage, cookies, cache |
| Performance | Profiling, bottlenecks |

## Debugging Mindset

### Stay Calm

- Bugs are normal, not personal failures
- Take breaks when frustrated
- Fresh eyes often spot issues immediately

### Be Systematic

- Don't randomly change things
- Test one hypothesis at a time
- Document what you've tried

### Trust Nothing

- Verify assumptions with evidence
- Check "impossible" scenarios anyway
- Read the actual error message carefully

### Ask for Help

When to escalate:
- After 30+ minutes with no progress
- When you need domain knowledge
- When a fresh perspective would help

## Anti-Patterns

| Don't | Instead |
|-------|---------|
| Change random things | Form hypothesis, test systematically |
| Assume you know the cause | Verify with evidence |
| Debug without reproducing | Create minimal reproduction first |
| Skip reading error messages | Read the complete error carefully |
| Add code without understanding | Understand existing code first |
| Debug in production | Reproduce locally first |

## Quick Reference

### Debugging Checklist

- [ ] Can I reproduce the bug?
- [ ] What changed recently?
- [ ] What does the error message say?
- [ ] What do the logs show?
- [ ] What layer is the bug in?
- [ ] What assumption might be wrong?
- [ ] Have I tested my hypothesis?

### When Stuck

1. Take a break (walk, coffee)
2. Explain the problem out loud
3. Re-read the error message
4. Check recent git changes
5. Search for similar issues
6. Ask for a second pair of eyes

## References

- `/debug:browser` — Visual and interaction debugging
- `/debug:api` — Data flow debugging (Component → Query → DAL → DB)
- `/debug:data` — Direct database inspection with MCP tools
- `/debug:test` — Test failure debugging
- `/debug:rubber-duck` — Guided problem articulation
- `/debug:logs` — Server log analysis
- `/debug:types` — TypeScript error debugging
- `/debug:performance` — Performance debugging
