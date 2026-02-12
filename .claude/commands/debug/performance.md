---
description: Diagnose performance issues including slow renders, bundle size, N+1 queries, and memory leaks
argument-hint: "[area-or-symptom] [--url <url>]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__playwright__browser_snapshot, mcp__playwright__browser_navigate, mcp__playwright__browser_console_messages, mcp__playwright__browser_network_requests, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_evaluate
---

# Performance Debugging

Diagnose and resolve performance issues including slow renders, large bundle sizes, N+1 database queries, memory leaks, and general sluggishness.

## Arguments

Parse `$ARGUMENTS`:
- If `--url <url>` flag provided, navigate to that URL for profiling
- Remaining text describes the performance symptom
- If empty, prompt for details

## Phase 1: Problem Identification

### 1.1 Describe the Symptom

```
AskUserQuestion:
  question: "What performance issue are you experiencing?"
  header: "Symptom"
  options:
    - label: "Slow page load"
      description: "Page takes a long time to display content"
    - label: "Sluggish interactions"
      description: "Clicks, typing, or scrolling feel laggy"
    - label: "Large bundle size"
      description: "JS bundle is too big, slow initial load"
    - label: "Memory issues"
      description: "Browser/app gets slower over time, high memory usage"
    - label: "Slow API/database"
      description: "Data fetching takes too long"
    - label: "General slowness"
      description: "Everything just feels slow"
```

### 1.2 Identify the Scope

```
AskUserQuestion:
  question: "Where is the performance issue occurring?"
  header: "Scope"
  options:
    - label: "Specific page"
      description: "One particular page is slow"
    - label: "Specific component"
      description: "A particular component is causing issues"
    - label: "All pages"
      description: "The entire app is slow"
    - label: "Build/deploy"
      description: "Build time or deployment is slow"
    - label: "Development only"
      description: "Only slow in dev mode"
```

### 1.3 Baseline Context

```
AskUserQuestion:
  question: "Was performance acceptable before?"
  header: "Timeline"
  options:
    - label: "Yes, recently degraded"
      description: "Used to be fast, now it's slow"
    - label: "Never been fast"
      description: "Has always been slow"
    - label: "Gets slower over time"
      description: "Starts fast, slows down during use"
    - label: "Inconsistent"
      description: "Sometimes fast, sometimes slow"
```

## Phase 2: Initial Profiling

### 2.1 Browser Performance Check

If URL provided, navigate and profile:

```
mcp__playwright__browser_navigate: { url: "[url]" }
mcp__playwright__browser_snapshot: {}
mcp__playwright__browser_console_messages: { level: "warning" }
mcp__playwright__browser_network_requests: { includeStatic: true }
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
mcp__playwright__browser_evaluate: {
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
rg "style=\{\{" src/ --type tsx | head -20

# Find arrow functions in JSX props
rg "onClick=\{\(\) =>" src/ --type tsx | head -20

# Find missing dependency arrays
rg "useEffect\([^,]+\)" src/ --type tsx | head -20
```

3. Check for large component trees:
```bash
# Find large components (many lines)
wc -l src/**/*.tsx | sort -rn | head -20
```

### 3.2 Large Bundle Size

**Symptoms**: Slow initial load, large JS download

**Investigation Steps**:

1. Analyze bundle:
```bash
# Build with analysis (if configured)
pnpm build

# Check output size
ls -la .next/static/chunks/*.js | sort -k5 -rn | head -10
```

2. Check for large dependencies:
```bash
# List installed packages by size
du -sh node_modules/* | sort -rh | head -20
```

3. Look for import issues:
```bash
# Find barrel imports that might pull in entire libraries
rg "from 'lodash'" src/ --type ts
rg "from 'date-fns'" src/ --type ts

# Should be:
# import { map } from 'lodash-es'
# import { format } from 'date-fns'
```

### 3.3 Database/API Performance

**Symptoms**: Slow data loading, API timeouts

**Investigation Steps**:

1. Check for N+1 queries in server logs:
```bash
grep -i "prisma" ".logs/$(ls -t .logs/ | head -1)" | grep -i "select" | head -30
```

2. Look for missing includes in Prisma queries:
```bash
# Find Prisma queries without includes
rg "prisma\.\w+\.find" src/layers/entities/ --type ts -A 3
```

3. Common N+1 pattern:
```typescript
// BAD: N+1 query
const users = await prisma.user.findMany()
for (const user of users) {
  const posts = await prisma.post.findMany({ where: { userId: user.id } })
}

// GOOD: Single query with include
const users = await prisma.user.findMany({
  include: { posts: true }
})
```

### 3.4 Memory Leaks

**Symptoms**: App gets slower over time, high memory usage

**Investigation Steps**:

1. Check for common memory leak patterns:
```bash
# Event listeners not cleaned up
rg "addEventListener" src/ --type tsx -A 5
rg "useEffect" src/ --type tsx -A 10 | grep -A 5 "addEventListener"

# Intervals/timeouts not cleared
rg "setInterval|setTimeout" src/ --type tsx -A 5

# Subscriptions not unsubscribed
rg "subscribe" src/ --type ts -A 5
```

2. Look for cleanup functions:
```bash
# useEffect should return cleanup
rg "useEffect\(" src/ --type tsx -A 20 | grep -A 15 "return \(\) =>"
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
# Build and run production locally
pnpm build && pnpm start
```

## Phase 4: Clarifying Questions

### 4.1 Determine Investigation Path

```
AskUserQuestion:
  question: "Based on initial analysis, which area should we focus on?"
  header: "Focus Area"
  options:
    - label: "Component renders"
      description: "Investigate React rendering performance"
    - label: "Bundle size"
      description: "Analyze and reduce JavaScript bundle"
    - label: "API/Database"
      description: "Optimize server-side queries"
    - label: "Memory usage"
      description: "Find and fix memory leaks"
    - label: "Network requests"
      description: "Optimize data fetching patterns"
```

### 4.2 Deep Dive Consent

```
AskUserQuestion:
  question: "This investigation may require code changes or running additional tools. How should we proceed?"
  header: "Approach"
  options:
    - label: "Full investigation"
      description: "Do whatever's needed to diagnose"
    - label: "Read-only"
      description: "Just analyze, don't change anything"
    - label: "Guided"
      description: "Ask me before each step"
```

## Phase 5: Common Fixes

### 5.1 React Rendering Fixes

**Add memoization:**
```typescript
// Memoize expensive calculations
const expensiveValue = useMemo(() => computeExpensive(data), [data])

// Memoize callbacks
const handleClick = useCallback(() => doSomething(), [])

// Memoize components
const MemoizedChild = React.memo(ChildComponent)
```

**Fix context performance:**
```typescript
// Split context into smaller pieces
const UserContext = createContext()
const ThemeContext = createContext() // Separate from user

// Memoize context value
const value = useMemo(() => ({ user, setUser }), [user])
```

### 5.2 Bundle Size Fixes

**Use dynamic imports:**
```typescript
// Before
import HeavyComponent from './HeavyComponent'

// After
const HeavyComponent = dynamic(() => import('./HeavyComponent'), {
  loading: () => <Skeleton />
})
```

**Tree-shake imports:**
```typescript
// Before (pulls entire library)
import _ from 'lodash'

// After (only imports used function)
import map from 'lodash-es/map'
```

### 5.3 Database Query Fixes

**Add includes:**
```typescript
// Before: N+1
const accounts = await prisma.account.findMany()
// Then separately fetching transactions for each

// After: Single query
const accounts = await prisma.account.findMany({
  include: { transactions: true }
})
```

**Add indexes in schema:**
```prisma
model Transaction {
  id        String   @id
  accountId String
  date      DateTime

  @@index([accountId])
  @@index([date])
}
```

### 5.4 Memory Leak Fixes

**Always cleanup effects:**
```typescript
useEffect(() => {
  const handler = () => { /* ... */ }
  window.addEventListener('resize', handler)

  return () => {
    window.removeEventListener('resize', handler) // Cleanup!
  }
}, [])
```

**Clear intervals:**
```typescript
useEffect(() => {
  const interval = setInterval(tick, 1000)
  return () => clearInterval(interval) // Cleanup!
}, [])
```

## Phase 6: Fix Implementation

### 6.1 Plan the Optimization

```
TodoWrite:
  todos:
    - content: "Profile and identify performance bottleneck"
      activeForm: "Profiling performance"
      status: "completed"
    - content: "Implement optimization"
      activeForm: "Implementing optimization"
      status: "pending"
    - content: "Measure improvement"
      activeForm: "Measuring improvement"
      status: "pending"
```

### 6.2 Measure Before/After

Before fixing, record baseline:
- Page load time
- Time to interactive
- Bundle size
- Memory usage

After fixing, measure again to confirm improvement.

### 6.3 Verify No Regressions

```
AskUserQuestion:
  question: "The optimization is implemented. How should we verify?"
  header: "Verification"
  options:
    - label: "Manual testing"
      description: "I'll test the app manually"
    - label: "Run performance benchmark"
      description: "Run automated performance tests"
    - label: "Both"
      description: "Manual testing plus benchmarks"
```

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

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Optimize another area"
      description: "Continue performance improvements"
    - label: "Add monitoring"
      description: "Set up performance monitoring"
    - label: "Document findings"
      description: "Create performance documentation"
    - label: "Commit changes"
      description: "Run /git:commit to save optimizations"
    - label: "Done"
      description: "I'm satisfied with the improvements"
```

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

**Database:**
- [ ] Use includes to avoid N+1
- [ ] Add indexes for frequent queries
- [ ] Pagination for large datasets
- [ ] Select only needed fields

**Memory:**
- [ ] Cleanup effects return functions
- [ ] Clear intervals/timeouts
- [ ] Unsubscribe from subscriptions
- [ ] Remove event listeners

### Common Performance Anti-patterns

| Anti-pattern | Impact | Fix |
|--------------|--------|-----|
| Inline objects `style={{}}` | Re-render | Define outside component |
| Inline functions `onClick={() => {}}` | Re-render | useCallback |
| Missing memo | Unnecessary re-renders | React.memo |
| Large images | Slow load | Optimize, lazy load |
| N+1 queries | Database overload | Use includes |
| No pagination | Memory, network | Add pagination |
| Barrel imports | Large bundle | Direct imports |

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
