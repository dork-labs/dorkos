---
description: Analyze server logs to diagnose errors, exceptions, and unexpected behavior
argument-hint: '[search-term] [--tail <lines>] [--level <level>] [--tag <tag>]'
allowed-tools: Read, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion
---

# Server Log Analysis

Systematically analyze server logs from the `.dork/logs/` directory to diagnose errors, exceptions, API failures, and unexpected behavior. DorkOS uses **NDJSON structured logging** — each line is a JSON object that can be filtered with `jq`.

## Log System Overview

- **Format**: NDJSON (newline-delimited JSON)
- **Active log**: `{DORK_HOME}/logs/dorkos.log`
- **Rotation**: Daily (`dorkos.YYYY-MM-DD.log`) + size-based within a day (`dorkos.YYYY-MM-DD.N.log`)
- **Fields**: `level`, `time`, `msg`, `tag` (optional), plus arbitrary context fields
- **Levels**: `fatal` (60), `error` (50), `warn` (40), `info` (30), `debug` (20), `trace` (10)

### DORK_HOME Location

The `.dork` directory location depends on the environment:

| Environment      | Location                   | How                                            |
| ---------------- | -------------------------- | ---------------------------------------------- |
| Development      | `apps/server/.temp/.dork/` | Auto-detected when `NODE_ENV !== 'production'` |
| Production (CLI) | `~/.dork/`                 | Default, or `DORK_HOME` env var                |
| Custom           | Any path                   | Set `DORK_HOME` env var                        |

Resolution logic is in `apps/server/src/lib/dork-home.ts`.

## Arguments

Parse `$ARGUMENTS`:

- If argument is a search term, grep for it in logs
- If `--tail <lines>` provided, show last N lines
- If `--level <level>` provided, filter by log level (error, warn, info, debug)
- If `--tag <tag>` provided, filter by component tag
- If empty, analyze latest log for errors

## Phase 1: Log Collection

### 1.1 Identify Log Location and Files

```bash
# Dev environment default
DORK_HOME="apps/server/.temp/.dork"

# List available log files (newest first)
ls -lt "$DORK_HOME/logs/" 2>/dev/null

# Show active log size
ls -la "$DORK_HOME/logs/dorkos.log" 2>/dev/null
wc -l "$DORK_HOME/logs/dorkos.log" 2>/dev/null
```

### 1.2 Clarify Analysis Scope

```
AskUserQuestion:
  question: "What would you like to analyze in the logs?"
  header: "Analysis Type"
  options:
    - label: "Recent errors"
      description: "Find all errors and warnings in recent logs"
    - label: "Specific component"
      description: "Filter by component tag (e.g., Relay, Mesh, Pulse, AgentManager)"
    - label: "API failures"
      description: "Find failed HTTP requests and route errors"
    - label: "Subsystem issues"
      description: "Focus on Relay, Mesh, or Pulse subsystem logs"
    - label: "Full log review"
      description: "Review the entire recent log"
```

## Phase 2: Log Analysis with NDJSON

### 2.1 Find Errors and Warnings

```bash
DORK_HOME="apps/server/.temp/.dork"
LOG="$DORK_HOME/logs/dorkos.log"

# All errors (level 50+)
cat "$LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('level', 0) >= 50:
            print(f\"[{obj.get('time','')}] {obj.get('tag','?')} {obj.get('msg','')}\"[:200])
    except: pass
" | tail -30

# All warnings (level 40+)
cat "$LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('level', 0) >= 40:
            print(f\"[{obj.get('time','')}] [{obj.get('level')}] {obj.get('tag','?')}: {obj.get('msg','')}\"[:200])
    except: pass
" | tail -50
```

### 2.2 Filter by Component Tag

Common tags in the codebase:

| Tag                  | Component                |
| -------------------- | ------------------------ |
| `DB`                 | Database initialization  |
| `Startup`            | Server startup sequence  |
| `Pulse`              | Pulse scheduler          |
| `Relay`              | Relay message bus        |
| `Mesh`               | Mesh agent discovery     |
| `AgentManager`       | Claude SDK sessions      |
| `BindingRouter`      | Adapter-agent routing    |
| `AdapterManager`     | Adapter lifecycle        |
| `SessionBroadcaster` | Cross-client sync        |
| `ConfigManager`      | Configuration            |
| `Request`            | HTTP request logging     |
| `Error`              | Error handler middleware |

```bash
# Filter by specific tag
cat "$LOG" | python3 -c "
import sys, json
tag = 'Relay'  # Change to desired tag
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if tag.lower() in obj.get('msg', '').lower() or obj.get('tag','') == tag:
            print(json.dumps(obj, indent=2))
    except: pass
" | tail -100
```

### 2.3 Filter by Time Range

```bash
# Logs from last N minutes
cat "$LOG" | python3 -c "
import sys, json
from datetime import datetime, timedelta, timezone
cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if obj.get('time', '') >= cutoff:
            print(f\"[{obj.get('time','')}] {obj.get('tag','?')}: {obj.get('msg','')}\"[:200])
    except: pass
"
```

### 2.4 Search for Specific Patterns

```bash
# Search by keyword in message
cat "$LOG" | python3 -c "
import sys, json
term = 'SEARCH_TERM'
for line in sys.stdin:
    try:
        obj = json.loads(line)
        if term.lower() in json.dumps(obj).lower():
            print(json.dumps(obj, indent=2))
    except: pass
" | tail -50
```

## Phase 3: Error Classification

### 3.1 DorkOS-Specific Error Patterns

| Category               | Log Pattern                                     | Typical Cause                           |
| ---------------------- | ----------------------------------------------- | --------------------------------------- |
| **Relay delivery**     | `ClaudeCodeAdapter: envelope .* has no replyTo` | Missing replyTo field in relay message  |
| **Binding failure**    | `BindingRouter: failed to persist session map`  | File system error writing sessions.json |
| **Adapter error**      | `AdapterManager: adapter .* failed`             | Adapter start/stop lifecycle issue      |
| **SDK error**          | `AgentManager: SDK query failed`                | Claude Agent SDK call failure           |
| **Mesh discovery**     | `Mesh: scan failed`                             | Discovery scan error                    |
| **Pulse execution**    | `Pulse: run .* failed`                          | Scheduled task execution failure        |
| **DB error**           | `DB: migration failed`                          | Database schema issue                   |
| **Boundary violation** | `403.*boundary`                                 | Path outside configured boundary        |
| **Session lock**       | `SESSION_LOCKED`                                | Concurrent write attempt                |

### 3.2 Correlate with State Files

When log errors reference subsystem state, cross-reference with data files:

```bash
DORK_HOME="apps/server/.temp/.dork"

# Check relay adapter config
cat "$DORK_HOME/relay/adapters.json" | python3 -m json.tool

# Check active bindings
cat "$DORK_HOME/relay/bindings.json" | python3 -m json.tool

# Check session mappings
cat "$DORK_HOME/relay/sessions.json" 2>/dev/null | python3 -m json.tool

# Check server config
cat "$DORK_HOME/config.json" | python3 -m json.tool
```

## Phase 4: Root Cause Investigation

### 4.1 Extract Full Error Context

For a specific error, get surrounding log lines:

```bash
# Get 5 lines before and 10 lines after a pattern
grep -n "ERROR_PATTERN" "$LOG" | head -1 | cut -d: -f1 | xargs -I{} sed -n '$(({}>=5?{}-5:1)),$(({} + 10))p' "$LOG"
```

Or use the Read tool with line offsets on the log file for precise context.

### 4.2 Trace to Code

Based on the component tag and error message:

1. Tags map to source files (e.g., `Relay` -> `packages/relay/src/`, `BindingRouter` -> `apps/server/src/services/relay/binding-router.ts`)
2. Search for the error message text in source code
3. Read the relevant code section

### 4.3 Check SQLite Database State

For Pulse/Relay/Mesh errors, query the consolidated database:

```bash
DORK_HOME="apps/server/.temp/.dork"

# Check recent pulse runs for failures
sqlite3 "$DORK_HOME/dork.db" "SELECT id, schedule_id, status, error, started_at FROM pulse_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 10;"

# Check relay message traces
sqlite3 "$DORK_HOME/dork.db" "SELECT message_id, status, adapter_id, error, created_at FROM relay_traces ORDER BY created_at DESC LIMIT 10;"

# Check registered agents
sqlite3 "$DORK_HOME/dork.db" "SELECT id, name, namespace, health_status FROM agents LIMIT 10;"
```

### 4.4 Correlate with Recent Changes

```bash
# Check recent git commits
git log --oneline -10

# Check what files changed recently
git diff --name-only HEAD~3
```

## Phase 5: Fix Guidance

### 5.1 Determine Fix Approach

```
AskUserQuestion:
  question: "Based on my analysis, how would you like to proceed?"
  header: "Next Action"
  options:
    - label: "Fix the code"
      description: "Let me fix the identified issue"
    - label: "Add better logging"
      description: "Add more context to help debug this"
    - label: "Check subsystem state"
      description: "Inspect relay/mesh/pulse state files and database"
    - label: "Investigate more"
      description: "I need more information before fixing"
```

## Phase 6: Wrap-Up

### 6.1 Summarize

```markdown
## Log Analysis Complete

**Error Found**: [Error type and message]
**Component**: [Tag/subsystem where error originated]
**Timestamp**: [When it occurred]
**Location**: [File:line where error originated]
**Root Cause**: [Why the error occurred]
**Solution**: [What was changed or recommended]
**Files Modified**: [List of files, if any]
```

## Quick Reference

### NDJSON Log Parsing Commands

```bash
DORK_HOME="apps/server/.temp/.dork"
LOG="$DORK_HOME/logs/dorkos.log"

# Pretty-print last 5 log entries
tail -5 "$LOG" | python3 -m json.tool

# Count entries by level
cat "$LOG" | python3 -c "
import sys, json
from collections import Counter
levels = Counter()
for line in sys.stdin:
    try: levels[json.loads(line).get('level', 'unknown')] += 1
    except: pass
for level, count in levels.most_common():
    print(f'{level}: {count}')
"

# Follow live logs (pretty-printed)
tail -f "$LOG" | while read line; do echo "$line" | python3 -m json.tool 2>/dev/null || echo "$line"; done

# Extract unique tags
cat "$LOG" | python3 -c "
import sys, json, re
tags = set()
for line in sys.stdin:
    try:
        msg = json.loads(line).get('msg', '')
        m = re.match(r'\[(\w+)\]', msg)
        if m: tags.add(m.group(1))
        tag = json.loads(line).get('tag', '')
        if tag: tags.add(tag)
    except: pass
print('\n'.join(sorted(tags)))
"
```

### Log File Locations

| File                                       | Purpose                              |
| ------------------------------------------ | ------------------------------------ |
| `{DORK_HOME}/logs/dorkos.log`              | Active log file                      |
| `{DORK_HOME}/logs/dorkos.YYYY-MM-DD.log`   | Daily rotated logs                   |
| `{DORK_HOME}/logs/dorkos.YYYY-MM-DD.N.log` | Size-rotated within a day            |
| `{DORK_HOME}/config.json`                  | Server configuration                 |
| `{DORK_HOME}/dork.db`                      | SQLite database (pulse, relay, mesh) |
| `{DORK_HOME}/relay/adapters.json`          | Adapter configurations               |
| `{DORK_HOME}/relay/bindings.json`          | Adapter-agent bindings               |
| `{DORK_HOME}/relay/sessions.json`          | Active session mappings              |

### HTTP Status Codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 400  | Bad Request - Zod validation failure |
| 403  | Forbidden - Boundary violation       |
| 404  | Not Found - Resource missing         |
| 409  | Conflict - Session locked            |
| 500  | Internal Server Error                |

## Important Behaviors

1. **ALWAYS** resolve the correct DORK_HOME path first
2. **PARSE** logs as NDJSON — never plain-text grep for structured data
3. **CORRELATE** timestamps with when the issue occurred
4. **CHECK** component tags to narrow which subsystem is involved
5. **CROSS-REFERENCE** with state files (adapters.json, bindings.json, dork.db)
6. **READ** full error context including surrounding log lines
7. **TRACE** to source code using the component tag mapping
