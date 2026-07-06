---
description: Diagnose performance issues including slow renders, bundle size, N+1 queries, and memory leaks
argument-hint: '[area-or-symptom] [--url <url>]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite, AskUserQuestion, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_evaluate
---

# Performance Debugging

Diagnose and resolve performance issues including slow renders, large bundle sizes, N+1 database queries, memory leaks, and general sluggishness.

## Arguments

Parse `$ARGUMENTS`:

- If `--url <url>` flag provided, navigate to that URL for profiling
- Remaining text describes the performance symptom
- If empty, prompt for details

## Phase 1: Problem Identification

Infer the symptom class (slow load / sluggish interactions / bundle size / memory / slow API / general), the scope (page, component, whole app, dev-only), and the timeline (recent regression vs always slow) from `$ARGUMENTS` and the initial profiling. Ask a clarifying question only when the answer genuinely changes the investigation path — a recent regression points at `git log`, "gets slower over time" points at leaks.

## Phase 2: Initial Profiling

### 2.1 Browser Performance Check

If URL provided, navigate and profile:

```
mcp__plugin_playwright_playwright__browser_navigate: { url: "[url]" }
mcp__plugin_playwright_playwright__browser_snapshot: {}
mcp__plugin_playwright_playwright__browser_console_messages: { level: "warning" }
mcp__plugin_playwright_playwright__browser_network_requests: { includeStatic: true }
```

### 2.2 Check for Console Warnings

Look for performance-related warnings:

- React rendering warnings
- Memory warnings
- Long task warnings
- Deprecated API warnings

### 2.3 Network Timing Analysis

Analyze network requests for:

- **Large payloads**: Responses > 100KB
- **Slow requests**: Requests > 1s
- **Waterfall issues**: Requests blocking each other
- **Duplicate requests**: Same endpoint called multiple times

### 2.4 Basic Performance Metrics

```
mcp__plugin_playwright_playwright__browser_evaluate: {
  function: "() => { const timing = performance.timing; return { loadTime: timing.loadEventEnd - timing.navigationStart, domReady: timing.domContentLoadedEventEnd - timing.navigationStart, firstPaint: performance.getEntriesByType('paint')[0]?.startTime || 'N/A' }; }"
}
```

## Phase 3: Specific Investigations

### 3.1 Slow Render / Re-render Issues

**Symptoms**: Sluggish UI, laggy interactions, high CPU usage

**Investigation Steps**:

1. Check for unnecessary re-renders:

```typescript
// Common causes
- Missing useMemo/useCallback
- Creating objects/arrays in render
- Context changes triggering tree re-renders
- Missing React.memo on child components
```

2. Search for common anti-patterns:

```bash
# Find inline object creation in JSX
rg "style=\{\{" apps/client/src/ --type tsx | head -20

# Find arrow functions in JSX props
rg "onClick=\{\(\) =>" apps/client/src/ --type tsx | head -20

# Find missing dependency arrays
rg "useEffect\([^,]+\)" apps/client/src/ --type tsx | head -20
```

3. Check for large component trees:

```bash
# Find large components (many lines)
find apps/client/src -name '*.tsx' | xargs wc -l | sort -rn | head -20
```

### 3.2 Large Bundle Size

**Symptoms**: Slow initial load, large JS download

**Investigation Steps**:

1. Analyze bundle:

```bash
# Build with analysis (if configured)
pnpm build

# Check Vite client bundle output size
ls -la apps/client/dist/assets/*.js | sort -k5 -rn | head -10

# Check server bundle output size (if CLI built)
ls -la packages/cli/dist/server/*.js 2>/dev/null | sort -k5 -rn | head -10
```

2. Check for large dependencies:

```bash
# List installed packages by size
du -sh node_modules/* | sort -rh | head -20
```

3. Look for import issues:

```bash
# Find barrel imports that might pull in entire libraries
rg "from 'lodash'" apps/ packages/ --type ts
rg "from 'date-fns'" apps/ packages/ --type ts

# Should be:
# import { map } from 'lodash-es'
# import { format } from 'date-fns'
```

### 3.3 Server/API Performance

**Symptoms**: Slow data loading, API timeouts

**Investigation Steps**:

1. Check server logs for slow requests:

```bash
DORK_HOME="apps/server/.temp/.dork"
LOG="$DORK_HOME/logs/dorkos.log"

# Find slow requests or errors in NDJSON logs
tail -500 "$LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('level', 0) >= 40:
            print(f\"[{obj.get('time','')}] {obj.get('tag','?')}: {obj.get('msg','')}\"[:200])
    except: pass
" | tail -30
```

2. Check SQLite query performance:

```bash
# Check database size and table row counts
DB="$DORK_HOME/dork.db"
sqlite3 "$DB" "SELECT 'pulse_runs', COUNT(*) FROM pulse_runs UNION ALL SELECT 'relay_index', COUNT(*) FROM relay_index UNION ALL SELECT 'relay_traces', COUNT(*) FROM relay_traces;"
```

3. Look for service-layer bottlenecks:

```bash
# Find service files that do heavy computation
rg "for.*await|Promise\.all|readdir|readFile" apps/server/src/services/ --type ts -l
```

### 3.4 Memory Leaks

**Symptoms**: App gets slower over time, high memory usage

**Investigation Steps**:

1. Check for common memory leak patterns:

```bash
# Event listeners not cleaned up
rg "addEventListener" apps/client/src/ --type tsx -A 5

# Intervals/timeouts not cleared
rg "setInterval|setTimeout" apps/client/src/ --type tsx -A 5

# Subscriptions not unsubscribed
rg "subscribe" apps/client/src/ --type ts -A 5
```

2. Look for cleanup functions:

```bash
# useEffect should return cleanup
rg "useEffect\(" apps/client/src/ --type tsx -A 20 | grep -A 15 "return \(\) =>"
```

### 3.5 Development Mode Slowness

**Symptoms**: Fast in production, slow in development

**Common Causes**:

- React Strict Mode double-rendering
- Source maps compilation
- Hot reload overhead
- Development-only logging

Check if issue is dev-specific:

```bash
# Run the production build locally — dev:dogfood serves the built CLI cockpit on :4242
pnpm build && pnpm dev:dogfood
```

## Phase 4: Focus

Pick the investigation path (renders, bundle, API/database, memory, network) yourself based on the profiling evidence — the bottleneck usually announces itself. State what you're focusing on and why before diving in.

## Phase 5: Common Fixes

### 5.1 React Rendering Fixes

**Add memoization:**

```typescript
// Memoize expensive calculations
const expensiveValue = useMemo(() => computeExpensive(data), [data]);

// Memoize callbacks
const handleClick = useCallback(() => doSomething(), []);

// Memoize components
const MemoizedChild = React.memo(ChildComponent);
```

**Fix context performance:**

```typescript
// Split context into smaller pieces
const UserContext = createContext();
const ThemeContext = createContext(); // Separate from user

// Memoize context value
const value = useMemo(() => ({ user, setUser }), [user]);
```

### 5.2 Bundle Size Fixes

**Use dynamic imports (Vite + React):**

```typescript
// Before
import HeavyComponent from './HeavyComponent';

// After — code-split with React.lazy; wrap usage in <Suspense fallback={<Skeleton />}>
const HeavyComponent = React.lazy(() => import('./HeavyComponent'));
```

**Tree-shake imports:**

```typescript
// Before (pulls entire library)
import _ from 'lodash';

// After (only imports used function)
import map from 'lodash-es/map';
```

### 5.3 Server/Database Fixes

**Add SQLite indexes for frequent queries:**

```sql
CREATE INDEX IF NOT EXISTS idx_relay_index_subject ON relay_index(subject);
CREATE INDEX IF NOT EXISTS idx_pulse_runs_schedule ON pulse_runs(schedule_id);
```

**Batch operations instead of loops:**

```typescript
// BAD: Sequential file reads
for (const id of sessionIds) {
  const transcript = await readTranscript(id);
}

// GOOD: Parallel with concurrency limit
const results = await Promise.all(sessionIds.map((id) => readTranscript(id)));
```

### 5.4 Memory Leak Fixes

**Always cleanup effects:**

```typescript
useEffect(() => {
  const handler = () => {
    /* ... */
  };
  window.addEventListener('resize', handler);

  return () => {
    window.removeEventListener('resize', handler); // Cleanup!
  };
}, []);
```

**Clear intervals:**

```typescript
useEffect(() => {
  const interval = setInterval(tick, 1000);
  return () => clearInterval(interval); // Cleanup!
}, []);
```

## Phase 6: Fix Implementation

### 6.1 Plan the Optimization

Track profile → optimize → measure with TodoWrite when the work spans multiple changes.

### 6.2 Measure Before/After

Before fixing, record baseline:

- Page load time
- Time to interactive
- Bundle size
- Memory usage

After fixing, measure again to confirm improvement.

### 6.3 Verify No Regressions

Re-run the same measurements from 6.2, re-exercise the affected flows in the browser, and run `pnpm typecheck` / relevant tests. Report the before/after numbers.

## Phase 7: Wrap-Up

### 7.1 Summarize

```markdown
## Performance Optimization Complete

**Issue**: [Original performance problem]
**Root Cause**: [What was causing the slowness]
**Solution**: [What was optimized]
**Improvement**: [Metrics before vs after]
**Files Modified**: [List of files]
```

### 7.2 Additional Recommendations

Based on investigation, suggest:

- Monitoring to add
- Future optimizations
- Best practices to follow

### 7.3 Offer Next Steps

Mention natural follow-ups where relevant: other areas worth optimizing, monitoring to add, or `/git:commit` to save the changes.

## Quick Reference

### Performance Checklist

**React:**

- [ ] useMemo for expensive calculations
- [ ] useCallback for callbacks passed to children
- [ ] React.memo for pure components
- [ ] Avoid inline objects in JSX
- [ ] Split large components

**Bundle:**

- [ ] Dynamic imports for heavy components
- [ ] Tree-shake imports (lodash-es, not lodash)
- [ ] Remove unused dependencies
- [ ] Analyze with bundle analyzer

**Database (SQLite/Drizzle):**

- [ ] Batch queries — no per-row queries in loops (N+1)
- [ ] Add indexes for frequent queries
- [ ] Pagination for large datasets
- [ ] Select only needed fields

**Memory:**

- [ ] Cleanup effects return functions
- [ ] Clear intervals/timeouts
- [ ] Unsubscribe from subscriptions
- [ ] Remove event listeners

### Common Performance Anti-patterns

| Anti-pattern                          | Impact                 | Fix                      |
| ------------------------------------- | ---------------------- | ------------------------ |
| Inline objects `style={{}}`           | Re-render              | Define outside component |
| Inline functions `onClick={() => {}}` | Re-render              | useCallback              |
| Missing memo                          | Unnecessary re-renders | React.memo               |
| Large images                          | Slow load              | Optimize, lazy load      |
| N+1 queries                           | Database overload      | Batch/join queries       |
| No pagination                         | Memory, network        | Add pagination           |
| Barrel imports                        | Large bundle           | Direct imports           |

## Important Behaviors

1. **MEASURE** before and after optimization
2. **PROFILE** before guessing at causes
3. **CHECK** if issue is dev-mode only
4. **AVOID** premature optimization
5. **FOCUS** on bottlenecks, not micro-optimizations
6. **TEST** for regressions after optimizing
7. **DOCUMENT** performance-critical code

## Edge Cases

- **Dev vs Prod**: Some issues only appear in one environment
- **Data size**: Performance may depend on data volume
- **Browser differences**: Some issues are browser-specific
- **Network conditions**: Test with throttled network
- **Cold vs warm**: First load vs cached load
