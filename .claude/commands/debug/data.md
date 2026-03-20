---
description: Inspect database and state files to debug data issues
argument-hint: '[table-or-query] [--relay] [--pulse] [--mesh]'
allowed-tools: Read, Grep, Glob, Bash, TodoWrite, AskUserQuestion
---

# Data Debugging

Inspect and verify database state and subsystem data files directly. Use this command to:

- View SQLite database tables and data
- Inspect relay state files (adapters, bindings, sessions, mailboxes)
- Debug "data not showing" issues
- Verify pulse schedule and run state
- Check mesh agent registry

## Data Architecture

DorkOS stores data in the `.dork` directory:

```
{DORK_HOME}/
├── config.json              # Server configuration
├── dork.db                  # SQLite database (WAL mode)
├── logs/
│   └── dorkos.log           # NDJSON structured logs
└── relay/
    ├── adapters.json         # Adapter configurations
    ├── bindings.json         # Adapter-agent bindings
    ├── sessions.json         # Active session mappings
    ├── subscriptions.json    # Active subscriptions
    ├── access-rules.json     # Access control rules
    └── mailboxes/            # Per-subject message files
        └── relay.*.json      # Message queues by subject
```

### DORK_HOME Location

| Environment | Location                            |
| ----------- | ----------------------------------- |
| Development | `apps/server/.temp/.dork/`          |
| Production  | `~/.dork/` (or `DORK_HOME` env var) |

## Arguments

Parse `$ARGUMENTS`:

- If a table name is provided, query that SQLite table
- If a SQL query is provided, execute it
- If `--relay` flag, inspect relay state files
- If `--pulse` flag, inspect pulse schedules and runs
- If `--mesh` flag, inspect mesh agent registry
- If empty, show overview and prompt for action

## Phase 1: Data Overview

### 1.1 Show Available Data Sources

```bash
DORK_HOME="apps/server/.temp/.dork"

echo "=== Config ==="
cat "$DORK_HOME/config.json" | python3 -m json.tool

echo "=== SQLite Tables ==="
sqlite3 "$DORK_HOME/dork.db" ".tables"

echo "=== Relay State Files ==="
ls -la "$DORK_HOME/relay/" 2>/dev/null

echo "=== Log Files ==="
ls -la "$DORK_HOME/logs/" 2>/dev/null
```

### 1.2 Determine Action

```
AskUserQuestion:
  question: "What would you like to inspect?"
  header: "Action"
  options:
    - label: "SQLite database"
      description: "Query pulse, relay, or mesh tables in dork.db"
    - label: "Relay state files"
      description: "Inspect adapters, bindings, sessions, mailboxes"
    - label: "Server configuration"
      description: "View config.json settings"
    - label: "Run a custom query"
      description: "Execute a specific SQL query"
```

## Phase 2: SQLite Database Inspection

### 2.1 Database Schema

The consolidated database (`dork.db`) contains these tables:

| Table                | Purpose                    | Key Columns                                             |
| -------------------- | -------------------------- | ------------------------------------------------------- |
| `pulse_schedules`    | Cron schedule definitions  | id, name, cron, status, enabled, prompt, cwd            |
| `pulse_runs`         | Schedule execution history | id, schedule_id, status, started_at, duration_ms, error |
| `relay_index`        | Relay message index        | id, subject, status, payload, created_at                |
| `relay_traces`       | Message delivery traces    | message_id, status, adapter_id, error                   |
| `agents`             | Mesh agent registry        | id, name, namespace, health_status                      |
| `agent_denials`      | Denied agent records       | agent_id, reason, denied_at                             |
| `rate_limit_buckets` | Rate limiting state        | key, tokens, last_refill                                |

### 2.2 Common Queries

```bash
DORK_HOME="apps/server/.temp/.dork"
DB="$DORK_HOME/dork.db"

# --- Pulse ---

# List all schedules
sqlite3 -header -column "$DB" "SELECT id, name, cron, status, enabled FROM pulse_schedules;"

# Recent runs (last 10)
sqlite3 -header -column "$DB" "SELECT id, schedule_id, status, started_at, duration_ms, error FROM pulse_runs ORDER BY started_at DESC LIMIT 10;"

# Failed runs
sqlite3 -header -column "$DB" "SELECT id, schedule_id, error, started_at FROM pulse_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 10;"

# --- Relay ---

# Recent messages
sqlite3 -header -column "$DB" "SELECT id, subject, status, created_at FROM relay_index ORDER BY created_at DESC LIMIT 10;"

# Message traces (delivery status)
sqlite3 -header -column "$DB" "SELECT message_id, status, adapter_id, error, created_at FROM relay_traces ORDER BY created_at DESC LIMIT 10;"

# --- Mesh ---

# Registered agents
sqlite3 -header -column "$DB" "SELECT id, name, namespace, health_status FROM agents;"

# Denied agents
sqlite3 -header -column "$DB" "SELECT agent_id, reason, denied_at FROM agent_denials ORDER BY denied_at DESC LIMIT 10;"

# --- Rate Limiting ---

# Current rate limit state
sqlite3 -header -column "$DB" "SELECT key, tokens, last_refill FROM rate_limit_buckets;"
```

### 2.3 Custom Query

For user-provided SQL:

```bash
# Validate it's a SELECT (read-only)
sqlite3 -header -column "$DORK_HOME/dork.db" "YOUR_SELECT_QUERY_HERE"
```

## Phase 3: Relay State File Inspection

### 3.1 Adapter Configuration

```bash
DORK_HOME="apps/server/.temp/.dork"

# View configured adapters (masks sensitive fields like tokens)
cat "$DORK_HOME/relay/adapters.json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for adapter in data.get('adapters', []):
    config = adapter.get('config', {})
    # Mask sensitive fields
    for key in ['token', 'secret', 'password', 'apiKey', 'authtoken']:
        if key in config:
            config[key] = config[key][:4] + '****' if len(config[key]) > 4 else '****'
    print(json.dumps(adapter, indent=2))
"
```

### 3.2 Adapter-Agent Bindings

```bash
# View all bindings
cat "$DORK_HOME/relay/bindings.json" | python3 -m json.tool

# Summary view
cat "$DORK_HOME/relay/bindings.json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in data.get('bindings', []):
    print(f\"  {b['adapterId']} -> {b['agentId']} ({b.get('sessionStrategy','?')}) label='{b.get('label','')}'\")
"
```

### 3.3 Session Mappings

```bash
# View active session mappings (binding-router state)
cat "$DORK_HOME/relay/sessions.json" 2>/dev/null | python3 -m json.tool
```

### 3.4 Mailbox Contents

```bash
# List mailbox message files
ls -la "$DORK_HOME/relay/mailboxes/" 2>/dev/null

# View messages for a specific subject
cat "$DORK_HOME/relay/mailboxes/relay.agent.*.json" 2>/dev/null | python3 -m json.tool | head -100
```

### 3.5 Access Rules and Subscriptions

```bash
# Access control rules
cat "$DORK_HOME/relay/access-rules.json" 2>/dev/null | python3 -m json.tool

# Active subscriptions
cat "$DORK_HOME/relay/subscriptions.json" 2>/dev/null | python3 -m json.tool
```

## Phase 4: Common Debugging Scenarios

### 4.1 "Message Not Delivered" Debugging

1. Check relay_index for the message:

   ```sql
   SELECT * FROM relay_index WHERE id = 'MESSAGE_ID';
   ```

2. Check relay_traces for delivery attempts:

   ```sql
   SELECT * FROM relay_traces WHERE message_id = 'MESSAGE_ID';
   ```

3. Check bindings match the message subject:

   ```bash
   cat "$DORK_HOME/relay/bindings.json" | python3 -m json.tool
   ```

4. Check adapter is enabled:
   ```bash
   cat "$DORK_HOME/relay/adapters.json" | python3 -c "
   import sys, json
   for a in json.load(sys.stdin).get('adapters', []):
       print(f\"  {a['id']}: enabled={a.get('enabled', False)}\")
   "
   ```

### 4.2 "Schedule Not Running" Debugging

1. Check schedule exists and is enabled:

   ```sql
   SELECT id, name, cron, status, enabled FROM pulse_schedules WHERE name LIKE '%SCHEDULE_NAME%';
   ```

2. Check recent run attempts:

   ```sql
   SELECT * FROM pulse_runs WHERE schedule_id = 'SCHEDULE_ID' ORDER BY started_at DESC LIMIT 5;
   ```

3. Check server config has pulse enabled:
   ```bash
   cat "$DORK_HOME/config.json" | python3 -c "import sys, json; print(json.load(sys.stdin).get('scheduler', {}))"
   ```

### 4.3 "Agent Not Discovered" Debugging

1. Check mesh is enabled in config:

   ```bash
   cat "$DORK_HOME/config.json" | python3 -c "import sys, json; print(json.load(sys.stdin).get('mesh', {}))"
   ```

2. Check registered agents:

   ```sql
   SELECT * FROM agents;
   ```

3. Check denied agents:
   ```sql
   SELECT * FROM agent_denials;
   ```

### 4.4 Post-Mutation Verification

After a create/update/delete operation:

```sql
-- Check most recent records in a table
SELECT * FROM [table] ORDER BY rowid DESC LIMIT 5;
```

## Phase 5: Wrap-Up

### 5.1 Summarize

```markdown
## Data Inspection Complete

**Data Source**: [SQLite table / relay file / config]
**Query/Check**: [What was inspected]
**Finding**: [What was found]
**Recommendation**: [Next steps if issues found]
```

## Quick Reference

### SQLite CLI Tips

```bash
DB="apps/server/.temp/.dork/dork.db"

# Pretty column output
sqlite3 -header -column "$DB" "SELECT ..."

# JSON output
sqlite3 -json "$DB" "SELECT ..."

# Show table schema
sqlite3 "$DB" ".schema pulse_schedules"

# Count rows
sqlite3 "$DB" "SELECT COUNT(*) FROM relay_index;"

# Export to CSV
sqlite3 -csv -header "$DB" "SELECT * FROM pulse_runs;" > runs.csv
```

### Data File Reference

| File                       | Format       | Purpose                                                |
| -------------------------- | ------------ | ------------------------------------------------------ |
| `config.json`              | JSON         | Server configuration (port, features, tunnel, logging) |
| `dork.db`                  | SQLite (WAL) | Pulse schedules/runs, relay index/traces, mesh agents  |
| `relay/adapters.json`      | JSON         | Adapter type, config (tokens masked), enabled state    |
| `relay/bindings.json`      | JSON         | Adapter-to-agent routing with session strategy         |
| `relay/sessions.json`      | JSON         | Active session ID mappings for binding-router          |
| `relay/subscriptions.json` | JSON         | Active relay subscriptions                             |
| `relay/access-rules.json`  | JSON         | Subject-level access control                           |
| `relay/mailboxes/*.json`   | JSON         | Per-subject message queues                             |

## Security Notes

- **Mask sensitive fields** when displaying adapter configs (tokens, secrets)
- All queries should be read-only (SELECT only)
- The SQLite database uses WAL mode — safe to read while server is running
- Relay state files may change while server is running — read atomically

## Important Behaviors

1. **ALWAYS** resolve the correct DORK_HOME path first
2. **MASK** sensitive fields (tokens, passwords) when displaying adapter configs
3. **USE** `sqlite3 -header -column` for readable output
4. **CROSS-REFERENCE** between SQLite data and JSON state files for full picture
5. **CHECK** feature flags in config.json before investigating subsystem data
