/**
 * Read per-turn usage out of the three runtimes' own on-disk transcripts.
 *
 * **These readers keep usage metadata and nothing else** — a timestamp, a model
 * id and a handful of token counts per assistant turn. Parsing a JSON line or a
 * stored message necessarily *touches* whatever text is in it, so the honest
 * claim is the narrower one: **nothing but those fields is ever retained,
 * returned or printed**, no message text, tool input, tool output or prompt
 * leaves these functions, and the OpenCode query pulls only the six fields it
 * needs rather than whole message bodies. Every file is opened read-only and
 * nothing is written back.
 *
 * Each runtime records usage in its own shape and its own convention, and the
 * three disagree in ways that silently corrupt a naive sum. The per-reader notes
 * below are the whole reason this file exists.
 *
 * @module scripts/agent-hours/readers
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyMix, type TokenMix } from './prices.js';

/** Which runtime produced a turn. */
export type Runtime = 'claude-code' | 'codex' | 'opencode';

/** Every runtime this script knows how to read, in report order. */
export const RUNTIMES: readonly Runtime[] = ['claude-code', 'codex', 'opencode'];

/** One assistant turn, reduced to the metadata this measurement needs. */
export interface Turn {
  readonly runtime: Runtime;
  /** Stable per-session key; hashed before it reaches any output. */
  readonly sessionKey: string;
  readonly model: string;
  /** End of the turn, epoch milliseconds. */
  readonly atMs: number;
  readonly mix: TokenMix;
  /**
   * A positive cost the runtime reported itself, when it reports one.
   *
   * A reported **zero** is deliberately not accepted: a locally-hosted model
   * genuinely costs nothing, but averaging its hours into a list-price rate as
   * `$0` drags that rate down while looking like real data. Those hours are
   * reported as unpriced instead.
   */
  readonly reportedCostUsd: number | null;
}

/** A non-negative finite number, or 0 for anything else. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Every `*.jsonl` under `root` modified at or after `sinceMs`, recursing into
 * subdirectories.
 *
 * The mtime filter is what keeps a short window cheap. Without it a `--days 1`
 * run reads every transcript ever written, exactly as a `--days 365` run does.
 * It is safe because a transcript is only ever appended to, so a file untouched
 * since before the window cannot hold a turn inside it.
 */
function findJsonl(root: string, sinceMs: number, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findJsonl(full, sinceMs, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
        // Raced with a delete; nothing to read.
      }
    }
  }
  return out;
}

/** Parse a JSONL file, skipping blank and malformed lines. */
function* jsonLines(file: string): Generator<Record<string, unknown>> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>;
    } catch {
      // A transcript being appended to while we read it can end mid-line.
    }
  }
}

/**
 * The Claude Code config roots to read.
 *
 * **Which profiles are in scope is the largest single lever on the answer** —
 * larger than the idle threshold, larger than any pricing choice. A machine that
 * runs several profiles side by side keeps a separate `projects/` tree per
 * profile, and they differ by an order of magnitude in size and by a factor of
 * three in cache-TTL mix. Reading one profile when you meant four undercounts by
 * most of the corpus; reading a profile that belongs to different work
 * contaminates the result with it. Neither failure announces itself, so the
 * resolution order is explicit and the caller is told what was chosen.
 *
 * `explicit` (from `--claude-root`) wins and is the only form that is
 * reproducible — **use it for any number you intend to quote.** Failing that,
 * `CLAUDE_CONFIG_DIR` — the variable Claude Code itself reads, colon- or
 * comma-separated — which is set inside a Claude Code session and will quietly
 * narrow the corpus to whichever profile is running the script. Failing that,
 * every `~/.claude*` directory holding a `projects/` folder.
 */
export function claudeRoots(explicit: readonly string[]): {
  roots: string[];
  source: 'flag' | 'env' | 'discovered';
} {
  if (explicit.length > 0) return { roots: [...explicit], source: 'flag' };
  // eslint-disable-next-line no-restricted-syntax -- another program's config var, not app env
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim()) {
    const roots = fromEnv
      .split(/[:,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (roots.length > 0) return { roots, source: 'env' };
  }
  const home = os.homedir();
  const found: string[] = [];
  for (const name of fs.readdirSync(home)) {
    if (!name.startsWith('.claude')) continue;
    const candidate = path.join(home, name);
    if (fs.existsSync(path.join(candidate, 'projects'))) found.push(candidate);
  }
  return { roots: found.sort(), source: 'discovered' };
}

/**
 * Read Claude Code transcripts.
 *
 * **The deduplication matters more than anything else in this file.** Claude
 * Code writes one transcript line per assistant *content block* — a thinking
 * block and the tool call that follows it are two lines — and each of those
 * lines carries a `usage` object for the single API response they came from. On
 * a real corpus roughly **half of all assistant lines are such repeats**, so
 * summing lines instead of responses inflates every token total by very nearly
 * 2×, silently, with a result that still looks entirely plausible. Responses are
 * keyed by `requestId`, falling back to `message.id`, per file.
 *
 * **The per-class maximum is taken across a response's lines, not the first
 * line.** Measured across 38,192 responses on a real corpus the counts are
 * identical on every line (they varied on 3, by 0.01% of output tokens in
 * aggregate), so the choice does not matter today — but nothing in the format
 * guarantees it, a progressive counter would be a plausible future change, and
 * such a counter is non-decreasing, so the maximum is right either way. It costs
 * one comparison and removes a silent dependency on an undocumented property.
 *
 * **Cache writes are split by TTL.** `cache_creation.ephemeral_1h_input_tokens`
 * bills at 2× input against the 5-minute tier's 1.25×, and a harness that opts
 * into 1-hour caching uses it for essentially every write, so collapsing the two
 * understates the cache-write line badly. Where the breakdown is absent the
 * rolled-up total is attributed to the 5-minute tier, which is the documented
 * default.
 */
export function readClaudeCode(
  roots: readonly string[],
  sinceMs: number,
  excludeProjects: readonly string[] = []
): Turn[] {
  const turns: Turn[] = [];
  for (const root of roots) {
    const projects = path.join(root, 'projects');
    for (const file of findJsonl(projects, sinceMs)) {
      // Claude Code names each project directory after the working directory it
      // was launched in, so a substring match on the path relative to
      // `projects/` is enough to leave a whole body of work out of the corpus.
      const relative = path.relative(projects, file);
      if (excludeProjects.some((needle) => relative.includes(needle))) continue;
      const byResponse = new Map<string, { atMs: number; model: string; mix: TokenMix }>();
      for (const line of jsonLines(file)) {
        if (line['type'] !== 'assistant') continue;
        const message = line['message'];
        if (!message || typeof message !== 'object') continue;
        const msg = message as Record<string, unknown>;
        const model = typeof msg['model'] === 'string' ? msg['model'] : '';
        // `<synthetic>` marks a locally generated message (an error notice, a
        // cancellation) that never reached the API and cost nothing.
        if (!model || model === '<synthetic>') continue;
        const usage = msg['usage'];
        if (!usage || typeof usage !== 'object') continue;

        const rawKey = line['requestId'] ?? msg['id'];
        const at = Date.parse(String(line['timestamp'] ?? ''));
        if (!Number.isFinite(at)) continue;
        // Without an id there is nothing to deduplicate against, so the line is
        // treated as its own response rather than dropped or merged blindly.
        const key = typeof rawKey === 'string' && rawKey ? rawKey : `${file}#${turns.length}${at}`;

        const u = usage as Record<string, unknown>;
        const creation = (u['cache_creation'] ?? {}) as Record<string, unknown>;
        const oneHour = num(creation['ephemeral_1h_input_tokens']);
        const fiveMin = num(creation['ephemeral_5m_input_tokens']);
        const rolled = num(u['cache_creation_input_tokens']);
        const mix: TokenMix = {
          // Anthropic's `input_tokens` already excludes cached tokens.
          input: num(u['input_tokens']),
          output: num(u['output_tokens']),
          cacheRead: num(u['cache_read_input_tokens']),
          cacheWrite5m: oneHour + fiveMin > 0 ? fiveMin : rolled,
          cacheWrite1h: oneHour,
        };

        const seen = byResponse.get(key);
        if (!seen) {
          byResponse.set(key, { atMs: at, model, mix });
          continue;
        }
        seen.atMs = Math.max(seen.atMs, at);
        seen.mix.input = Math.max(seen.mix.input, mix.input);
        seen.mix.output = Math.max(seen.mix.output, mix.output);
        seen.mix.cacheRead = Math.max(seen.mix.cacheRead, mix.cacheRead);
        seen.mix.cacheWrite5m = Math.max(seen.mix.cacheWrite5m, mix.cacheWrite5m);
        seen.mix.cacheWrite1h = Math.max(seen.mix.cacheWrite1h, mix.cacheWrite1h);
      }

      for (const response of byResponse.values()) {
        turns.push({
          runtime: 'claude-code',
          // The file is the session: two profiles can hold the same session id,
          // and a subagent's transcript is its own file, which is exactly the
          // fan-out this measurement wants counted separately.
          sessionKey: file,
          model: response.model,
          atMs: response.atMs,
          mix: response.mix,
          reportedCostUsd: null,
        });
      }
    }
  }
  return turns;
}

/**
 * Read Codex rollouts.
 *
 * Codex writes one `token_usage_record` line per API response, so there is no
 * block-level duplication to undo — but its `usage.input_tokens` **includes**
 * `cached_input_tokens`, the opposite of Anthropic's convention, where
 * `input_tokens` already excludes them. Subtract before comparing; adding them
 * instead double-counts the cache, which on a cache-dominated workload is most
 * of the total. (Verified on a real corpus: `total_tokens` equals
 * `input_tokens + output_tokens` in all 55,774 records, so the cached figure is
 * inside the input figure.) `reasoning_output_tokens` is likewise a subset of
 * `output_tokens`, not an addend.
 *
 * Codex reports no cache TTL, so its cache writes go to the 5-minute tier.
 *
 * The model id is carried on `turn_context` lines, which precede the usage
 * records they apply to, so the most recent one is tracked as the file is
 * scanned.
 */
export function readCodex(root: string, sinceMs: number): Turn[] {
  const turns: Turn[] = [];
  for (const file of findJsonl(root, sinceMs)) {
    let model = 'unknown';
    for (const line of jsonLines(file)) {
      const payload = line['payload'];
      if (!payload || typeof payload !== 'object') continue;
      const p = payload as Record<string, unknown>;

      if (line['type'] === 'turn_context' || line['type'] === 'session_meta') {
        if (typeof p['model'] === 'string' && p['model']) model = p['model'];
        continue;
      }
      if (line['type'] !== 'token_usage_record') continue;

      const usage = p['usage'];
      if (!usage || typeof usage !== 'object') continue;
      const at = Date.parse(String(line['timestamp'] ?? ''));
      if (!Number.isFinite(at)) continue;

      const u = usage as Record<string, unknown>;
      const cacheRead = num(u['cached_input_tokens']);
      const mix = emptyMix();
      mix.input = Math.max(0, num(u['input_tokens']) - cacheRead);
      mix.output = num(u['output_tokens']);
      mix.cacheRead = cacheRead;
      mix.cacheWrite5m = num(u['cache_write_input_tokens']);
      turns.push({
        runtime: 'codex',
        sessionKey: file,
        model,
        atMs: at,
        mix,
        reportedCostUsd: null,
      });
    }
  }
  return turns;
}

/**
 * The file OpenCode keeps its global store in.
 *
 * Mirrors OpenCode's own resolution — `$XDG_DATA_HOME || ~/.local/share` joined
 * with `opencode`, on every platform including macOS, where it deliberately does
 * not use `~/Library/Application Support`. The same rule is implemented for the
 * server in `apps/server/src/services/runtimes/opencode/opencode-data-dir.ts`;
 * this script reimplements the one line rather than importing it, because that
 * module sits behind the server's `NodeNext` `.js`-specifier graph and a report
 * script has no other reason to pull the server's module tree in.
 */
export function openCodeStorePath(): string {
  // eslint-disable-next-line no-restricted-syntax -- another program's XDG path, not app env
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

/**
 * Read the OpenCode store.
 *
 * **The snapshot copies the write-ahead log with the database.** OpenCode runs
 * in WAL mode, so recent writes live in `opencode.db-wal` and not in the main
 * file; copying the main file alone silently loses whatever has not been
 * checkpointed — and a byte copy of a database being written to is not even
 * guaranteed to be a consistent image on its own. Copying the `-wal` and `-shm`
 * sidecars alongside it gives SQLite everything it needs to recover a coherent
 * view. The real store is read but never opened by SQLite and never locked, so a
 * running OpenCode is undisturbed; the snapshot is removed on the way out,
 * including when a read throws.
 *
 * The query pulls only the fields this measurement needs, so message bodies are
 * never loaded. OpenCode's model ids are provider-local aliases with no public
 * list price, so its own reported cost is used — but only when positive, since a
 * locally-hosted model reports `0` and averaging that into a list-price rate as
 * real data would drag the rate down.
 */
export async function readOpenCode(dbPath: string): Promise<Turn[]> {
  if (!fs.existsSync(dbPath)) return [];
  // Imported here, not at module scope, so the experimental-SQLite warning is
  // not printed on every run of a script that usually has no OpenCode store.
  const { DatabaseSync } = await import('node:sqlite');

  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hours-'));
  const snapshot = path.join(snapshotDir, 'opencode.db');
  const turns: Turn[] = [];
  try {
    fs.copyFileSync(dbPath, snapshot);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, snapshot + suffix);
    }
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT session_id AS sessionId,
                  json_extract(data, '$.role')            AS role,
                  json_extract(data, '$.modelID')         AS modelId,
                  json_extract(data, '$.cost')            AS cost,
                  json_extract(data, '$.tokens.input')    AS input,
                  json_extract(data, '$.tokens.output')   AS output,
                  json_extract(data, '$.tokens.cache.read')  AS cacheRead,
                  json_extract(data, '$.tokens.cache.write') AS cacheWrite,
                  json_extract(data, '$.time.completed')  AS completed,
                  json_extract(data, '$.time.created')    AS created
           FROM message
           WHERE json_extract(data, '$.role') = 'assistant'`
        )
        .all();
      for (const row of rows) {
        const sessionId = row['sessionId'];
        if (typeof sessionId !== 'string') continue;
        const at = num(row['completed']) || num(row['created']);
        if (!at) continue;
        const mix = emptyMix();
        mix.input = num(row['input']);
        mix.output = num(row['output']);
        mix.cacheRead = num(row['cacheRead']);
        mix.cacheWrite5m = num(row['cacheWrite']);
        const cost = row['cost'];
        turns.push({
          runtime: 'opencode',
          sessionKey: sessionId,
          model: typeof row['modelId'] === 'string' ? row['modelId'] : 'unknown',
          atMs: at,
          mix,
          reportedCostUsd:
            typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null,
        });
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
  return turns;
}
