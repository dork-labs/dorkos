/**
 * Measure **tokens and dollars per active agent-hour** from this machine's own
 * agent transcripts — Claude Code's, Codex's and OpenCode's.
 *
 * ```bash
 * pnpm measure:agent-hours                        # last 30 days, text report
 * pnpm measure:agent-hours -- --days 7            # a shorter window
 * pnpm measure:agent-hours -- --json              # machine-readable
 * pnpm measure:agent-hours -- --gap-minutes 3     # a stricter idle threshold
 * pnpm measure:agent-hours -- --reprice claude-opus-5
 * ```
 *
 * **Pin the window for any number you intend to quote.** `--days` is relative to
 * now, and transcripts are appended to continuously, so the same command gives a
 * slightly different answer every time it runs. `--since` and `--until` are
 * reproducible; `--days` is for a quick look.
 *
 * **Why this exists.** "Cost per active agent-hour" is the unit every capacity
 * and unit-cost conversation reduces to, and until it is measured it is a guess.
 * The runtimes already report per-turn usage (`supportsCostTracking` in
 * `packages/shared/src/agent-runtime.ts`), but DorkOS streams that number to the
 * UI rather than persisting it, so the durable record is each runtime's own
 * transcript on disk. This reads those and turns them into a rate.
 *
 * **It keeps usage metadata and nothing else.** Per assistant turn it takes a
 * timestamp, a model id and a few token counts. Parsing a transcript line
 * necessarily touches whatever is in it, but nothing beyond those fields is ever
 * retained or printed — no message text, tool input, tool output or prompt — and
 * session identifiers are hashed before they reach the output. Every file is
 * opened read-only and nothing is written anywhere except the report on stdout.
 *
 * **The method, and why each choice was made, is
 * `research/20260915_tokens-per-agent-hour-method.md`.** In short: an *agent* is
 * one runtime session, so a subagent is its own agent; a turn's *active
 * interval* runs from the previous turn in that session to this one, clamped to
 * `--gap-minutes`; *active agent-hours* sum those intervals across sessions, so
 * two agents running for one hour are two agent-hours; *wall-clock hours* take
 * their union, so overlapping agents collapse into one; and `fanOut` is the
 * ratio. Percentiles are taken over session-hour buckets weighted by active
 * time. §7 of the note lists the biases in both directions; the net sign is not
 * guaranteed, so do not read any figure here as a bound.
 *
 * @module scripts/measure-agent-hours
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  HOUR_MS,
  measureFanOut,
  parseBucketKey,
  summarize,
  toBuckets,
  toSlices,
  type Bucket,
  type Stats,
} from './agent-hours/aggregate.js';
import {
  CACHE_READ_RATIO,
  CACHE_WRITE_1H_RATIO,
  CACHE_WRITE_5M_RATIO,
  MODEL_PRICES,
  priceFor,
} from './agent-hours/prices.js';
import {
  claudeRoots,
  openCodeStorePath,
  readClaudeCode,
  readCodex,
  readOpenCode,
  RUNTIMES,
  type Turn,
} from './agent-hours/readers.js';

/** Every flag the script accepts; anything else is a typo, not a no-op. */
const VALUE_FLAGS = [
  'days',
  'since',
  'until',
  'gap-minutes',
  'min-bucket-minutes',
  'reprice',
  'claude-root',
  'exclude-project',
  'codex-root',
  'opencode-db',
] as const;
const BOOLEAN_FLAGS = ['json'] as const;

/** Everything the run was configured with. */
interface Options {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly gapMs: number;
  readonly minBucketMs: number;
  readonly json: boolean;
  /** Model id whose list price every runtime's tokens are also priced at. */
  readonly repriceModel: string;
  readonly claude: { roots: string[]; source: 'flag' | 'env' | 'discovered' };
  readonly excludeProjects: readonly string[];
  readonly codexRoot: string;
  readonly openCodeDb: string;
}

/**
 * Reject anything that is not a flag this script knows, and any value flag left
 * without a value.
 *
 * Silently ignoring an unknown flag is the worst of both worlds: `--day 7`
 * reports a full month and says nothing, and a value flag written last
 * (`--days`) falls back to its default just as quietly. Both produce a number
 * that answers a different question from the one asked.
 */
function validateArgv(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) continue;
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new Error(
        `unknown flag ${token}; known flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS]
          .map((f) => `--${f}`)
          .join(', ')}`
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} needs a value`);
    }
    i += 1;
  }
}

/** Read `--flag value`, returning `undefined` when the flag is absent. */
function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/** Read a repeated `--flag value` into a list. */
function flags(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (value) out.push(value);
  }
  return out;
}

/** A positive number from a flag, or `fallback`. */
function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} takes a positive number; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Turn `process.argv` into options, rejecting anything malformed. */
export function parseOptions(argv: readonly string[]): Options {
  validateArgv(argv);

  const until = flag(argv, 'until');
  const untilMs = until ? Date.parse(until) : Date.now();
  if (!Number.isFinite(untilMs)) throw new Error(`--until is not a date: ${String(until)}`);

  const since = flag(argv, 'since');
  const days = numberFlag(argv, 'days', 30);
  const sinceMs = since ? Date.parse(since) : untilMs - days * 24 * HOUR_MS;
  if (!Number.isFinite(sinceMs)) throw new Error(`--since is not a date: ${String(since)}`);
  if (sinceMs >= untilMs) throw new Error('--since must be earlier than --until');

  const repriceModel = flag(argv, 'reprice') ?? 'claude-sonnet-5';
  if (!priceFor(repriceModel)) {
    throw new Error(
      `--reprice needs a model with a published price; known: ${Object.keys(MODEL_PRICES).join(', ')}`
    );
  }

  return {
    sinceMs,
    untilMs,
    gapMs: numberFlag(argv, 'gap-minutes', 5) * 60_000,
    minBucketMs: numberFlag(argv, 'min-bucket-minutes', 5) * 60_000,
    json: argv.includes('--json'),
    repriceModel,
    claude: claudeRoots(flags(argv, 'claude-root')),
    excludeProjects: flags(argv, 'exclude-project'),
    codexRoot: flag(argv, 'codex-root') ?? path.join(os.homedir(), '.codex', 'sessions'),
    openCodeDb: flag(argv, 'opencode-db') ?? openCodeStorePath(),
  };
}

/** Sessions are hashed so no filesystem path reaches the report. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Round to a fixed number of decimals, keeping `null` as `null`. */
function round(value: number | null, decimals: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Format a count for the text report; a dash marks "no figure available". */
function show(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = round(value, decimals) ?? 0;
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Group buckets by a key derived from their composite bucket key. */
function groupBy(
  buckets: ReadonlyMap<string, Bucket>,
  pick: (parts: readonly [string, string, string, number]) => string | null
): Map<string, Bucket[]> {
  const groups = new Map<string, Bucket[]>();
  for (const [key, bucket] of buckets) {
    const group = pick(parseBucketKey(key));
    if (group === null) continue;
    const list = groups.get(group);
    if (list) list.push(bucket);
    else groups.set(group, [bucket]);
  }
  return groups;
}

/** The whole measurement, as a plain value. */
async function measure(options: Options) {
  // Transcripts are append-only, so a file untouched since before the window
  // cannot hold a turn inside it; the readers use that to skip most of the disk.
  const all: Turn[] = [
    ...readClaudeCode(options.claude.roots, options.sinceMs, options.excludeProjects),
    ...readCodex(options.codexRoot, options.sinceMs),
    ...(await readOpenCode(options.openCodeDb)),
  ];
  const inWindow = all.filter((t) => t.atMs >= options.sinceMs && t.atMs < options.untilMs);
  const slices = toSlices(inWindow, options.gapMs, priceFor(options.repriceModel));
  const buckets = toBuckets(slices);

  const byRuntime = groupBy(buckets, (parts) => parts[0]);
  const byModel = groupBy(buckets, (parts) => `${parts[0]}/${parts[2]}`);

  return {
    window: {
      since: new Date(options.sinceMs).toISOString(),
      until: new Date(options.untilMs).toISOString(),
      days: round((options.untilMs - options.sinceMs) / (24 * HOUR_MS), 2),
      pinned: Boolean(flag(process.argv, 'since') || flag(process.argv, 'until')),
    },
    definitions: {
      gapMinutes: options.gapMs / 60_000,
      minBucketMinutes: options.minBucketMs / 60_000,
      cacheReadRatio: CACHE_READ_RATIO,
      cacheWrite5mRatio: CACHE_WRITE_5M_RATIO,
      cacheWrite1hRatio: CACHE_WRITE_1H_RATIO,
      repriceModel: options.repriceModel,
      agent: 'one runtime session; a subagent is its own agent',
      bucket: 'one session inside one UTC clock hour; percentiles weighted by active time',
    },
    sources: {
      // Basenames only: enough to spot a missing or unwanted profile, without
      // putting a home directory into a report that may be pasted elsewhere.
      claudeProfiles: options.claude.roots.map((root) => path.basename(root)),
      claudeRootSource: options.claude.source,
      excludedProjects: options.excludeProjects,
    },
    sample: {
      turns: inWindow.length,
      turnsOutsideWindow: all.length - inWindow.length,
      sessions: new Set(inWindow.map((t) => `${t.runtime}/${hashKey(t.sessionKey)}`)).size,
      runtimes: Object.fromEntries(
        RUNTIMES.map((runtime) => {
          const mine = inWindow.filter((t) => t.runtime === runtime);
          return [
            runtime,
            { turns: mine.length, sessions: new Set(mine.map((t) => hashKey(t.sessionKey))).size },
          ];
        })
      ),
    },
    overall: summarize([...buckets.values()], options.minBucketMs),
    fanOut: measureFanOut(slices),
    perRuntime: Object.fromEntries(
      [...byRuntime].map(([name, list]) => [name, summarize(list, options.minBucketMs)])
    ),
    perModel: Object.fromEntries(
      [...byModel]
        .map(([name, list]) => [name, summarize(list, options.minBucketMs)] as const)
        .sort((a, b) => b[1].activeHours - a[1].activeHours)
    ),
  };
}

/** Render a fixed-width table: first column left-aligned, the rest right. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length))
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

/** Print the human-readable report. */
function printText(report: Awaited<ReturnType<typeof measure>>): void {
  const { definitions: d, sample, fanOut } = report;
  const lines: string[] = [
    `window       ${report.window.since} → ${report.window.until} (${show(report.window.days, 1)} days)` +
      (report.window.pinned ? '' : '  [relative — pin --since/--until to reproduce]'),
    `definitions  gap ${d.gapMinutes}m, min bucket ${d.minBucketMinutes}m, cache read ` +
      `${CACHE_READ_RATIO * 100}% of input, cache write ${CACHE_WRITE_5M_RATIO * 100}% (5m) / ` +
      `${CACHE_WRITE_1H_RATIO * 100}% (1h)`,
    `profiles     ${report.sources.claudeProfiles.join(', ') || '(none found)'} ` +
      `[from ${report.sources.claudeRootSource}]` +
      (report.sources.claudeRootSource === 'flag'
        ? ''
        : '  — pass --claude-root to pin which profiles count') +
      (report.sources.excludedProjects.length > 0
        ? `\n             excluding projects matching: ${report.sources.excludedProjects.join(', ')}`
        : ''),
    `sample       ${sample.turns} turns over ${sample.sessions} sessions`,
  ];
  for (const runtime of RUNTIMES) {
    const row = sample.runtimes[runtime];
    if (row) lines.push(`             ${runtime}: ${row.turns} turns, ${row.sessions} sessions`);
  }
  lines.push(
    '',
    `active agent-hours   ${show(fanOut.agentHours, 1)}   ` +
      `wall-clock hours ${show(fanOut.wallClockHours, 1)}   ` +
      `fan-out ×${show(fanOut.fanOut, 2)}`,
    `concurrent agents    p50 ${show(fanOut.p50Concurrency, 0)}   ` +
      `p95 ${show(fanOut.p95Concurrency, 0)}   max ${fanOut.maxConcurrency}`,
    ''
  );

  const header = [
    'scope',
    'hours',
    'priced h',
    'bkts',
    'cache%',
    'tok/h mean',
    'tok/h p50',
    'tok/h p95',
    '$/h mean',
    '$/h p50',
    '$/h p95',
    `$/h @${d.repriceModel}`,
  ];
  const rows: string[][] = [];
  const push = (scope: string, stats: Stats) => {
    rows.push([
      scope,
      show(stats.activeHours, 1),
      show(stats.usdPerHour?.pricedHours ?? null, 1),
      String(stats.buckets),
      show(stats.tokenShare.cacheRead * 100, 0),
      show(stats.tokensPerHour.mean, 0),
      show(stats.tokensPerHour.p50, 0),
      show(stats.tokensPerHour.p95, 0),
      show(stats.usdPerHour?.mean ?? null, 2),
      show(stats.usdPerHour?.p50 ?? null, 2),
      show(stats.usdPerHour?.p95 ?? null, 2),
      show(stats.repricedUsdPerHour?.mean ?? null, 2),
    ]);
  };
  push('ALL', report.overall);
  for (const [name, stats] of Object.entries(report.perRuntime)) push(name, stats);
  for (const [name, stats] of Object.entries(report.perModel)) push(`  ${name}`, stats);

  lines.push(
    ...table(header, rows),
    '',
    `$/h is public list price for each row's own model; the last column reprices the same tokens at ${d.repriceModel}.`,
    'A dash means no published rate. "priced h" is the time behind the $/h columns — where it is below',
    '"hours", those dollars cover only part of the row and must not be multiplied by the full hour count.',
    '"bkts" is how many buckets cleared the minimum size and fed the percentiles; means use every bucket,',
    'so a row showing 0 buckets has a mean and no meaningful spread.',
    'Biases run in both directions (method note §7) — these are estimates, not bounds.'
  );

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = await measure(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printText(report);
}

await main();
