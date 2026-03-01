---
title: "AI-Parseable Log Design: Research Findings"
date: 2026-03-01
type: external-best-practices
status: active
tags: [logging, ai-parseable, structured-logs, design, patterns]
feature_slug: logging-infrastructure
---

# AI-Parseable Log Design: Research Findings

**Date**: 2026-03-01
**Research Mode**: Deep Research
**Searches Performed**: 12
**Sources Consulted**: 18

---

## Research Summary

Structured NDJSON logging is the current industry consensus for both human-readable and machine-parseable logs. For AI/LLM agent consumption specifically, the critical constraint is context window fit: a single log file should target 200–500 KB (roughly 50K–125K tokens for JSON content), with hybrid daily+size rotation using 10–50 MB limits keeping archived files queryable. File naming should use ISO 8601 timestamps (`YYYY-MM-DD`) at the front of the filename for lexicographic sorting. Retention of 7–30 days covers the vast majority of developer tool debugging needs.

---

## Key Findings

1. **Ideal AI-Consumable Log Size**: Target 200–500 KB per active file segment; a 4,000-character chunk (~1,000 tokens) is the smallest unit recommended for LLM analysis batches. A 10 MB file = ~2.5M tokens, which blows any current context window.

2. **Log Rotation Strategy**: Hybrid rotation (daily + size cap of 10–50 MB) is the modern standard. `pino-roll` supports both `frequency: 'daily'` and `size: '10m'` simultaneously. Size-only or time-only strategies each have failure modes; combining both produces consistently bounded files.

3. **NDJSON Field Improvements**: Add `correlationId`, `sessionId`, and `spanId` fields consistently. Field ordering should follow: timestamp → level → message → ids → context → error detail. Include units in field names (`durationMs`, `memoryBytes`). Use OpenTelemetry Semantic Conventions as the naming baseline.

4. **File Naming Convention**: Use `YYYY-MM-DD` prefix (ISO 8601 compact) in filenames. `pino-roll`'s `dateFormat: 'yyyy-MM-dd'` produces `app.2026-03-01.log` which sorts correctly with `ls`. Avoid colons (prohibited on Windows/macOS HFS+). Optionally append sequence numbers for intra-day rotation: `app.2026-03-01.1.log`.

5. **Retention Policy**: 7–14 days for debug/info logs in developer tools; 30 days for error logs; up to 90 days for audit/security logs. For a local developer tool (DorkOS), 7 days of rotated files with 5–10 archived files is appropriate. Compress archives with `.gz`.

---

## Detailed Analysis

### 1. Ideal Log File Size for AI Context Windows

#### Token Math

JSON is verbose: special characters, repeated field names, and whitespace inflate token counts. A reasonable estimate for NDJSON log data:

- 1 token ≈ 4 characters (general English)
- JSON adds ~30–40% overhead vs. plain text due to keys, quotes, brackets
- Effective ratio for NDJSON logs: **1 token ≈ 3–3.5 characters**

| File Size | Est. Characters | Est. Tokens (JSON) |
|-----------|----------------|---------------------|
| 100 KB | ~100,000 chars | ~28,000–33,000 tokens |
| 200 KB | ~200,000 chars | ~57,000–67,000 tokens |
| 500 KB | ~500,000 chars | ~143,000–167,000 tokens |
| 1 MB | ~1,000,000 chars | ~285,000–333,000 tokens |
| 10 MB | ~10,000,000 chars | ~2.5M–3.3M tokens |

**Current model context windows** (as of early 2026):
- Claude 3.5/Sonnet 4: 200K tokens
- GPT-4o: 128K tokens
- Gemini 1.5 Pro: 1M tokens (but performance degrades with "context rot" at long ranges)

**Sweet spot for direct feed into AI context**: 100–200 KB (~30K–60K tokens). This leaves room for system prompt, conversation history, and response generation within a 200K token window.

**Practical recommendation**: Target active log files at **50–200 KB before rotation** for AI-consumable segments. Archive files at up to **10 MB** (for full-day captures that can be chunked/summarized rather than fed raw).

#### Context Rot Warning

Research from Epoch AI (2025) confirms that LLM performance degrades at the extremes of context windows through a "lost in the middle" phenomenon. Critical log entries should be structured so high-severity events are easily extractable without reading the entire file. This argues for:

1. Separate error-level log files (only ERROR/FATAL entries) that stay small
2. NDJSON format enabling streaming line-by-line rather than full-file loading
3. Chunking strategy: Splunk's engineering team recommends 4,000-character chunks when feeding logs to LLMs for analysis

#### Chunk-Friendly Design Principle

Each NDJSON line must be self-contained and meaningful in isolation. An AI agent analyzing a single line should be able to understand the event without reading surrounding lines. This means:
- No multi-line log entries (stack traces must be a single JSON string field)
- No log entries that reference "the previous line" or "above"
- Complete context in every entry (session ID, request ID, component name)

---

### 2. Log Rotation Strategies

#### Strategy Comparison

| Strategy | Pros | Cons |
|----------|------|------|
| **Size-only** | Bounded file sizes | Files can span multiple days; hard to correlate with time |
| **Time-only (daily)** | Easy to reason about by date | High-traffic days produce huge files |
| **Hybrid (daily + size)** | Bounded by both; best for AI consumption | Slightly more complex naming |

**Verdict**: Hybrid rotation is the modern standard. Tools like `pino-roll`, `winston-daily-rotate-file`, and logrotate all support it.

#### pino-roll Configuration (Recommended for DorkOS)

`pino-roll` is the official Pino ecosystem transport for log rotation. Key options:

```javascript
import pino from 'pino';
import { join } from 'path';

const transport = pino.transport({
  target: 'pino-roll',
  options: {
    file: join(process.env.DORK_HOME ?? '~/.dork', 'logs', 'app.log'),
    frequency: 'daily',         // Rotate at midnight UTC
    dateFormat: 'yyyy-MM-dd',   // Produces: app.2026-03-01.log
    size: '10m',                // Also rotate when file exceeds 10 MB
    mkdir: true,                // Auto-create log directory
    limit: { count: 14 },       // Keep last 14 rotated files (2 weeks)
    extension: '.log',
    // Optional: symlink current.log -> active file for tail-following
    symlink: true,
  }
});

const logger = pino({ level: 'info' }, transport);
```

**Resulting file pattern**: `~/.dork/logs/app.2026-03-01.log`, `app.2026-03-01.1.log` (intra-day rotation when size exceeded)

**Size recommendation by log volume**:
- Low traffic (developer tool, <100 req/min): `size: '10m'`, `limit.count: 14`
- Medium traffic: `size: '50m'`, `limit.count: 7`
- High traffic: `size: '100m'`, `limit.count: 3`, add compression

#### winston-daily-rotate-file Configuration

For Winston users:

```javascript
import winston from 'winston';
import 'winston-daily-rotate-file';

const transport = new winston.transports.DailyRotateFile({
  filename: '%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  dirname: '~/.dork/logs',
  maxSize: '10m',
  maxFiles: '14d',           // Keep 14 days (string with 'd' suffix)
  compress: true,            // gzip archives
  zippedArchive: true,
});
```

#### Logrotate (System-Level, Linux/macOS)

For production deployments, system logrotate provides the most robust rotation:

```
~/.dork/logs/*.log {
    daily
    size 10M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        # Signal app to reopen log files if needed
    endscript
}
```

---

### 3. Structured Log Format for AI Parseability

#### Recommended NDJSON Schema

Every log line should include these fields in this order (order aids human scanning even if JSON parsers don't care):

```json
{
  "time": "2026-03-01T14:23:45.123Z",
  "level": "info",
  "msg": "Session created",
  "correlationId": "req_8f3a2b1c",
  "sessionId": "sess_uuid-here",
  "component": "agent-manager",
  "durationMs": 142,
  "pid": 12345,
  "hostname": "dorkos-dev"
}
```

**Field naming conventions** (OpenTelemetry Semantic Conventions baseline):
- `time` — ISO 8601 with milliseconds and `Z` suffix (not `timestamp`, not `ts`, not Unix epoch integers)
- `level` — lowercase string: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- `msg` — human-readable message (Pino uses `msg`; Winston uses `message`; pick one and be consistent)
- `correlationId` — traces a request across services/components
- `sessionId` — ties events to a Claude session
- `component` — the module/service that emitted the log (e.g., `agent-manager`, `transcript-reader`)
- `durationMs` — embed units in field names; never a bare `duration` field
- `err` — for errors, use structured error object: `{ "type": "Error", "message": "...", "stack": "..." }`

**Error log example**:
```json
{
  "time": "2026-03-01T14:23:45.123Z",
  "level": "error",
  "msg": "SDK query failed",
  "correlationId": "req_8f3a2b1c",
  "sessionId": "sess_uuid-here",
  "component": "agent-manager",
  "err": {
    "type": "SDKError",
    "message": "Rate limit exceeded",
    "code": 429,
    "stack": "SDKError: Rate limit exceeded\n  at query (agent-manager.ts:142)"
  }
}
```

#### Why NDJSON Over Plain JSON Array

- **Streamable**: Parseable line-by-line without loading entire file into memory
- **Append-safe**: No need to patch closing brackets; just append new lines
- **AI-friendly**: Each line is an independent, self-contained context unit
- **Tool-compatible**: Native to Elasticsearch, Datadog, Splunk, Loki, pino, winston
- **Corruption-resilient**: A malformed line affects only that line, not the file

#### AI-Specific Field Additions

For logs that AI agents will consume, add semantic context fields:

```json
{
  "time": "2026-03-01T14:23:45.123Z",
  "level": "info",
  "msg": "Tool approval requested",
  "correlationId": "req_8f3a2b1c",
  "sessionId": "sess_uuid-here",
  "component": "interactive-handlers",
  "event": "tool_approval_requested",
  "toolName": "Bash",
  "toolInput": { "command": "git status" },
  "agentId": "agent_proj-slug"
}
```

The `event` field (a stable event type code) is critical for AI analysis — it allows grouping and pattern-matching without NLP on the `msg` string. This pattern comes from event-driven architecture but is equally valuable for log analysis.

#### Token Efficiency Considerations

TOON format (Token-Optimized Object Notation, 2025) achieves 30–60% token reduction over JSON for tabular data by declaring field names once in a header rather than per-row. However:

- TOON is not yet widely supported by log tooling
- NDJSON with short field names achieves similar gains for logs (use `msg` not `message`, `time` not `timestamp`)
- The practical recommendation is to **use abbreviated but readable field names** in NDJSON

**Token-saving field name choices**:
| Verbose | Preferred | Savings |
|---------|-----------|---------|
| `timestamp` | `time` | ~2 tokens/line |
| `message` | `msg` | ~1 token/line |
| `logLevel` | `level` | ~1 token/line |
| `errorMessage` | `err.message` | ~1 token/line |
| `requestIdentifier` | `reqId` | ~2 tokens/line |

At 1,000 log lines, these savings compound to ~7,000 fewer tokens — meaningful for context window budgeting.

---

### 4. File Naming Conventions

#### ISO 8601 Compact Format (Recommended)

The universally correct format for log filenames that sort chronologically with `ls`, `find`, and other Unix tools:

```
{appname}.{YYYY-MM-DD}.log
{appname}.{YYYY-MM-DD}.{N}.log   (intra-day sequence for size rotation)
```

**Examples**:
```
dorkos.2026-03-01.log
dorkos.2026-03-01.1.log
dorkos.2026-03-01.2.log
dorkos.2026-03-02.log
```

**Why this works**:
- ISO 8601 dates are lexicographically ordered (year → month → day, most-significant first)
- `ls -l` sorts them chronologically without any special flags
- Easily parsed by regex: `\d{4}-\d{2}-\d{2}`
- Human-readable at a glance
- Cross-platform safe (no colons, no spaces, no special chars)

#### Intra-Day Rotation with pino-roll

When size-based rotation fires within a day, pino-roll appends a sequence counter:

```
app.2026-03-01.log    → first file of the day
app.2026-03-01.1.log  → after first rotation (size exceeded)
app.2026-03-01.2.log  → after second rotation
```

This preserves chronological sort order while allowing multiple files per day.

#### For Error-Only Logs (Separate File Recommended)

```
dorkos-error.{YYYY-MM-DD}.log
```

Keeping error logs separate means:
- An AI agent can load only the error file for diagnosis (much smaller context)
- Error logs can have longer retention (30 days vs. 7 for debug logs)
- Monitoring tools can watch a single small file for alerting

#### Naming Anti-Patterns to Avoid

```
app.log.1              # Ambiguous sort order
app_20260301.log       # Missing separators; harder to parse
app-2026-03-01.log     # Hyphens before date; sorts differently
app.2026-3-1.log       # Missing leading zeros; breaks lexicographic sort
2026-03-01-app.log     # Date-first is fine but unusual for app logs
app.log.2026-03-01     # Extension after date; inconsistent
```

---

### 5. Retention Policies

#### By Log Level and Type

| Log Type | Recommended Retention | Rationale |
|----------|----------------------|-----------|
| **Trace/Debug** | 3–7 days | High volume; rarely needed after initial debugging |
| **Info** | 7–14 days | Standard operational visibility window |
| **Error** | 30 days | Post-incident investigation window |
| **Fatal/Audit** | 90 days | Compliance; rare events need longer history |

**For DorkOS (developer tool, local deployment)**: 7-day retention with `limit.count: 14` (2 weeks of daily files) provides good coverage without disk bloat.

#### Storage Budgeting

At 10 MB/day cap with 14-day retention:
- Maximum uncompressed storage: 140 MB
- With gzip compression (~70% reduction): ~42 MB
- Highly reasonable for a local developer tool

At 50 MB/day cap with 7-day retention:
- Maximum uncompressed: 350 MB
- With compression: ~105 MB

#### Tiered Retention Strategy (For Higher-Value Logs)

1. **Hot** (0–7 days): Uncompressed `.log` files; fast access for debugging
2. **Warm** (7–30 days): Gzip-compressed `.log.gz`; available but slower to access
3. **Cold** (30–90 days): Error/audit logs only; archived or moved to cheaper storage

#### Automation

Use `pino-roll`'s `limit.count` for automatic pruning. For more sophisticated policies, a cleanup cron via Node.js `node-cron` or system cron:

```javascript
// Cleanup logs older than N days
import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';

async function pruneOldLogs(logDir: string, maxAgeDays: number) {
  const files = await readdir(logDir);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.endsWith('.log') && !file.endsWith('.log.gz')) continue;
    const { mtimeMs } = await stat(join(logDir, file));
    if (mtimeMs < cutoff) await unlink(join(logDir, file));
  }
}
```

---

## Synthesis: Recommendations for DorkOS

Given DorkOS is a local developer tool with the Server at `~/.dork/`, here are the concrete recommendations:

### Log Directory Structure
```
~/.dork/
└── logs/
    ├── current.log -> dorkos.2026-03-01.log   (symlink, optional)
    ├── dorkos.2026-03-01.log                  (active)
    ├── dorkos.2026-03-01.1.log               (intra-day overflow)
    ├── dorkos.2026-02-28.log.gz              (compressed archive)
    └── dorkos-error.2026-03-01.log           (error-only stream)
```

### Pino Configuration
```javascript
const pinoRollOptions = {
  file: join(dorkHome, 'logs', 'dorkos.log'),
  frequency: 'daily',
  dateFormat: 'yyyy-MM-dd',
  size: '10m',            // Rotate if file exceeds 10 MB mid-day
  mkdir: true,
  symlink: true,          // current.log -> active file (easy to tail)
  limit: { count: 14 },  // Keep 14 rotated files (~2 weeks)
};
```

### NDJSON Field Schema
```typescript
interface LogEntry {
  time: string;           // ISO 8601: "2026-03-01T14:23:45.123Z"
  level: string;          // "trace" | "debug" | "info" | "warn" | "error" | "fatal"
  msg: string;            // Human-readable message
  component: string;      // "agent-manager" | "transcript-reader" | etc.
  correlationId?: string; // Request-scoped trace ID
  sessionId?: string;     // Claude session UUID
  durationMs?: number;    // Duration with units in name
  err?: {                 // Structured error (not string)
    type: string;
    message: string;
    stack?: string;
    code?: number;
  };
  pid: number;            // Added by pino automatically
  hostname: string;       // Added by pino automatically
}
```

### Retention Policy
- Info logs: 14 days (`limit.count: 14` in pino-roll)
- Error logs (separate stream): 30 days
- No cold-tier needed for a local developer tool

---

## Research Gaps and Limitations

- **TOON format**: Promising 30–60% token reduction, but no production-grade logging library support yet (as of early 2026). Worth monitoring for future adoption.
- **Optimal chunk size for AI analysis**: The 4,000-character recommendation comes from LLM log anomaly detection research; the ideal chunk size likely varies by model and log density.
- **Correlation ID standards**: No single universal correlation ID format has emerged. OpenTelemetry's W3C Trace Context (`traceparent` header) is the closest thing to a standard but is designed for HTTP, not log files.
- **GPU/LLM inference logs**: This research focused on application logs; model serving logs have different characteristics (extremely high volume, numerical data) that may warrant different approaches.

---

## Contradictions and Disputes

- **pino-roll vs. external logrotate**: Better Stack's pino guide recommends external logrotate; the `pino-roll` README and pinojs maintainers recommend pino-roll as the first-class solution. For a Node.js app without system admin access (like a developer CLI tool), pino-roll is clearly the better choice. For containerized/server deployments, logrotate gives more control.

- **Log file size "sweet spot"**: No source gives a single definitive number for AI consumption. The 200 KB figure in the summary is derived from first principles (token math + context window budgets) rather than empirical measurement. Actual optimal size depends heavily on log verbosity, model, and use case.

- **Field name verbosity**: TOON/token-efficiency research suggests shorter names; OpenTelemetry semantic conventions use long descriptive names (`exception.stacktrace`). For DorkOS's use case (developer tool with pino), Pino's short-name defaults (`msg`, `time`, `level`) are the pragmatic choice.

---

## Sources and Evidence

- "JSONL for Logs provides structure while maintaining the simplicity of line-based logging" — [NDJSON.com Log Processing Guide](https://ndjson.com/use-cases/log-processing/)
- pino-roll `frequency`, `size`, `dateFormat`, `limit.count` API — [pino-roll GitHub (mcollina)](https://github.com/mcollina/pino-roll)
- "TOON achieves 30-60% token reduction across various data types" — [TOON vs JSON: Why AI Agents Need Token-Optimized Data Formats](https://jduncan.io/blog/2025-11-11-toon-vs-json-agent-optimized-data/)
- "Optimal chunk size: 4,000 characters per submission" for LLM log analysis — [How to Use LLMs for Log File Analysis | Splunk](https://www.splunk.com/en_us/blog/learn/log-file-analysis-llms.html)
- OpenTelemetry field naming conventions (`exception.type`, `exception.message`) — [Structured Logging for Modern Applications | Dash0](https://www.dash0.com/guides/structured-logging-for-modern-applications)
- Log retention by type: application logs 14–90 days, error logs ~30 days — [Log Retention Best Practices | Last9](https://last9.io/blog/log-retention/)
- "Context rot" at long context extremes — [Context Window Problem | Factory.ai](https://factory.ai/news/context-window-problem)
- ISO 8601 lexicographic ordering for filenames — [Sorting ISO 8601 timestamps | DEV Community](https://dev.to/adnauseum/sorting-iso-8601-timestamps-5am2)
- "Include contextual identifiers to track individual requests" — [Adding Logs to AI Agents | Michael Brenndoerfer](https://mbrenndoerfer.com/writing/adding-logs-to-ai-agents-observability-debugging)
- Hybrid daily+size rotation as modern standard — [What Is Log Rotation | EdgeDelta](https://edgedelta.com/company/knowledge-center/what-is-log-rotation)
- Token budget strategy (context allocation) — [Context Length Optimization Guide 2025 | Local AI Zone](https://local-ai-zone.github.io/guides/context-length-optimization-ultimate-guide-2025.html)
- LLM log anomaly detection context window: 4,000 tokens — [LLMs for Log Anomaly Detection | ARCsoft UVic](https://arcsoft.uvic.ca/log/2025-10-17-llm-for-log-anomaly-detection/)

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: `"pino-roll" configuration npm`, `structured logging best practices 2025 AI NDJSON`, `log filename ISO 8601 chronological sorting`, `TOON vs JSON AI agent token efficient`
- Primary source types: Official package documentation (npm/GitHub), engineering blogs (Splunk, Dash0, Better Stack), academic research (ARCsoft), format specifications (NDJSON.com)
