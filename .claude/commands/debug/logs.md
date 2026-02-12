---
description: Analyze server logs to diagnose errors, exceptions, and unexpected behavior
argument-hint: "[search-term] [--tail <lines>]"
allowed-tools: Read, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion
---

# Server Log Analysis

Systematically analyze server logs from the `.logs/` directory to diagnose errors, exceptions, API failures, and unexpected behavior. This command helps correlate log entries with code paths.

## Project Logging

The dev server outputs logs to `.logs/` with timestamped filenames:
- **Location**: `.logs/`
- **Format**: `YYYY-MM-DD_HH-MM-SS.log`
- **Latest log**: `ls -t .logs/ | head -1`

## Arguments

Parse `$ARGUMENTS`:
- If argument is a search term, grep for it in logs
- If `--tail <lines>` provided, show last N lines
- If empty, analyze latest log for errors

## Phase 1: Log Collection

### 1.1 Identify Log File

```bash
# Find the latest log file
LATEST_LOG=$(ls -t .logs/ 2>/dev/null | head -1)
echo "Latest log: .logs/$LATEST_LOG"

# Show log file stats
ls -la ".logs/$LATEST_LOG"
wc -l ".logs/$LATEST_LOG"
```

### 1.2 Clarify Analysis Scope

```
AskUserQuestion:
  question: "What would you like to analyze in the logs?"
  header: "Analysis Type"
  options:
    - label: "Recent errors"
      description: "Find all errors and exceptions in recent logs"
    - label: "Specific request"
      description: "I'll provide details about a specific request to trace"
    - label: "API failures"
      description: "Find failed API requests (4xx/5xx responses)"
    - label: "Database issues"
      description: "Find Prisma/database related errors"
    - label: "Full log review"
      description: "Review the entire recent log"
```

### 1.3 Time Context

```
AskUserQuestion:
  question: "What time range are you interested in?"
  header: "Time Range"
  options:
    - label: "Just now"
      description: "Last few minutes"
    - label: "Last hour"
      description: "Within the past hour"
    - label: "Today's session"
      description: "Since I started the dev server"
    - label: "Specific time"
      description: "I'll tell you the approximate time"
```

## Phase 2: Log Analysis

### 2.1 Find Errors and Exceptions

```bash
# Search for errors in latest log
grep -i -E "error|exception|failed|fatal|critical" ".logs/$(ls -t .logs/ | head -1)" | tail -50
```

### 2.2 Find API Request Failures

```bash
# Find HTTP error responses
grep -E "HTTP/[0-9.]+ [45][0-9]{2}" ".logs/$(ls -t .logs/ | head -1)" | tail -30

# Find specific status codes
grep -E "status.*[45][0-9]{2}|[45][0-9]{2}.*status" ".logs/$(ls -t .logs/ | head -1)" | tail -30
```

### 2.3 Find Database/Prisma Issues

```bash
# Search for Prisma errors
grep -i -E "prisma|database|postgres|neon|query|constraint" ".logs/$(ls -t .logs/ | head -1)" | grep -i -E "error|failed|exception" | tail -20
```

### 2.4 Find Specific Patterns

If user provided a search term:
```bash
grep -i "[search-term]" ".logs/$(ls -t .logs/ | head -1)" | tail -50
```

## Phase 3: Error Classification

### 3.1 Classify Errors Found

Common error categories:

| Category | Pattern | Typical Cause |
|----------|---------|---------------|
| **Unhandled Promise** | `UnhandledPromiseRejection` | Missing await or catch |
| **Type Error** | `TypeError` | Null/undefined access |
| **Prisma Error** | `PrismaClientKnownRequestError` | Query/constraint issue |
| **Auth Error** | `UnauthorizedError`, `401` | Session/token issue |
| **Validation Error** | `ZodError`, `ValidationError` | Invalid input data |
| **Module Error** | `ModuleNotFoundError` | Import path issue |
| **Connection Error** | `ECONNREFUSED`, `timeout` | Network/DB connection |

### 3.2 Ask About Error Priority

If multiple errors found:

```
AskUserQuestion:
  question: "I found multiple errors. Which would you like to investigate?"
  header: "Error Focus"
  options:
    - label: "Most recent"
      description: "Focus on the latest error"
    - label: "Most frequent"
      description: "Focus on the error that occurs most often"
    - label: "Most severe"
      description: "Focus on fatal/critical errors first"
    - label: "Specific error"
      description: "I'll tell you which one"
```

## Phase 4: Root Cause Investigation

### 4.1 Extract Error Context

For a specific error, extract:
- **Timestamp**: When did it occur?
- **Request context**: What endpoint/action was called?
- **Stack trace**: Where in the code did it happen?
- **Input data**: What data was being processed?

### 4.2 Trace to Code

Based on stack trace or error message:

```
Find the file and line number from the error.
Read the relevant code section.
Understand the context that caused the error.
```

### 4.3 Check Related Logs

Look for context before/after the error:
```bash
# Get lines around the error
grep -B 5 -A 10 "[error-pattern]" ".logs/$(ls -t .logs/ | head -1)"
```

### 4.4 Correlate with Recent Changes

```bash
# Check recent git commits
git log --oneline -10

# Check what files changed recently
git diff --name-only HEAD~3
```

## Phase 5: Common Error Patterns

### 5.1 Unhandled Promise Rejection

**Log Pattern**: `UnhandledPromiseRejectionWarning` or `unhandledRejection`

**Common Causes**:
- Missing `await` on async function
- Missing `.catch()` on promise
- Async error not propagated

**Fix Pattern**:
```typescript
// Add try/catch
try {
  await riskyOperation()
} catch (error) {
  console.error('Operation failed:', error)
  throw error // or handle appropriately
}
```

### 5.2 Prisma Constraint Error

**Log Pattern**: `PrismaClientKnownRequestError`, `P2002` (unique), `P2003` (foreign key)

**Common Causes**:
- Duplicate unique value
- Missing related record
- Invalid foreign key

**Debugging**:
```bash
# Check the constraint name in the error
grep -i "constraint" ".logs/$(ls -t .logs/ | head -1)"
```

### 5.3 Auth/Session Error

**Log Pattern**: `401`, `UnauthorizedError`, `session`

**Common Causes**:
- Expired session
- Missing auth token
- `requireAuth()` failing

**Check**:
- Is user authenticated?
- Is session cookie present?
- Is session valid in database?

### 5.4 Timeout Error

**Log Pattern**: `ETIMEDOUT`, `timeout`, `ECONNREFUSED`

**Common Causes**:
- Database connection pool exhausted
- External API slow/down
- Network issues

**Debugging**:
```bash
# Check for connection patterns
grep -i -E "connect|timeout|refused" ".logs/$(ls -t .logs/ | head -1)" | tail -20
```

## Phase 6: Fix Guidance

### 6.1 Determine Fix Approach

```
AskUserQuestion:
  question: "Based on my analysis, how would you like to proceed?"
  header: "Next Action"
  options:
    - label: "Fix the code"
      description: "Let me fix the identified issue"
    - label: "Add better logging"
      description: "Add more context to help debug this"
    - label: "Add error handling"
      description: "Add proper error handling around this code"
    - label: "Investigate more"
      description: "I need more information before fixing"
```

### 6.2 Plan the Fix

```
TodoWrite:
  todos:
    - content: "Analyze error logs and identify root cause"
      activeForm: "Analyzing error logs"
      status: "completed"
    - content: "Trace error to source code"
      activeForm: "Tracing to source code"
      status: "pending"
    - content: "Implement fix"
      activeForm: "Implementing fix"
      status: "pending"
    - content: "Verify error no longer occurs"
      activeForm: "Verifying fix"
      status: "pending"
```

## Phase 7: Wrap-Up

### 7.1 Summarize

```markdown
## Log Analysis Complete

**Error Found**: [Error type and message]
**Timestamp**: [When it occurred]
**Location**: [File:line where error originated]
**Root Cause**: [Why the error occurred]
**Solution**: [What was changed or recommended]
**Files Modified**: [List of files, if any]
```

### 7.2 Monitoring Recommendation

Suggest improvements:
- Better error logging in the affected area
- Alerting for critical errors
- Error tracking setup

### 7.3 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Fix the identified issue"
      description: "Implement the fix I described"
    - label: "Analyze more logs"
      description: "Look for other issues"
    - label: "Add error handling"
      description: "Improve error handling in affected code"
    - label: "Tail logs live"
      description: "Watch logs in real-time for new errors"
    - label: "Done"
      description: "I have the information I need"
```

## Quick Reference

### Log Search Commands

```bash
# Latest log file
LATEST=".logs/$(ls -t .logs/ | head -1)"

# All errors
grep -i error "$LATEST" | tail -50

# Specific time range (if timestamps in logs)
grep "2025-12-10 14:" "$LATEST"

# Count error types
grep -i error "$LATEST" | cut -d: -f3 | sort | uniq -c | sort -rn

# Follow live logs
tail -f "$LATEST"
```

### Common Prisma Error Codes

| Code | Meaning |
|------|---------|
| P2002 | Unique constraint violation |
| P2003 | Foreign key constraint violation |
| P2025 | Record not found |
| P2014 | Required relation violation |
| P2021 | Table does not exist |

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Auth required |
| 403 | Forbidden - No permission |
| 404 | Not Found - Resource missing |
| 409 | Conflict - Resource conflict |
| 500 | Internal Server Error |
| 502 | Bad Gateway - Upstream error |
| 503 | Service Unavailable |

## Important Behaviors

1. **ALWAYS** check the latest log file first
2. **CORRELATE** timestamps with when the issue occurred
3. **READ** full stack traces to understand error origin
4. **TRACE** to source code to understand context
5. **CHECK** recent git changes if error is new
6. **PRESERVE** log files when debugging complex issues
7. **ADD** better logging if current logs are insufficient

## Edge Cases

- **Large log files**: Use `tail` and `grep` to narrow down
- **Multiple log files**: Check if error spans multiple sessions
- **Missing timestamps**: Add timestamps to logging
- **Sensitive data in logs**: Be careful not to expose secrets
