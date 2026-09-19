/**
 * GitHub access, only through the `gh` CLI (the dependency budget, plan §4.1),
 * behind a small interface so tests replay recorded responses instead.
 *
 * Every call counts against a budget. In Actions the collector runs on
 * `GITHUB_TOKEN`, which allows 1,000 REST requests an hour per repository, so
 * the daily run stops asking before it gets near that and records the day as
 * late instead of pressing on (plan §4.4: "late, never truncated").
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

/** What the engine needs from GitHub. */
export interface Gh {
  /** GET a REST path, e.g. `repos/o/r/actions/runs?per_page=100`. */
  rest(path: string): unknown;
  /** Run one GraphQL query. */
  graphql(query: string): unknown;
  /**
   * Download a run's artifacts whose names match `pattern` into `dir`.
   *
   * @returns How many artifacts arrived; 0 when none matched.
   */
  downloadArtifacts(runId: number, pattern: string, dir: string): number;
  /**
   * Core requests left in the token's current hour, or `null` when unknown.
   * GitHub does not count this call against the limit, and neither does the budget.
   */
  remaining(): number | null;
  /** Requests made so far. */
  readonly calls: number;
  /** Requests this run may make in total. */
  readonly budget: number;
}

/** Thrown before a request that would exceed the budget. Callers catch it and record the work as late. */
export class BudgetExhausted extends Error {
  constructor(budget: number) {
    super(`API budget of ${budget} requests is spent`);
    this.name = 'BudgetExhausted';
  }
}

/** Runs `gh` with arguments and returns stdout; throws on a non-zero exit. */
export type GhExec = (args: readonly string[]) => string;

const realExec: GhExec = (args) =>
  execFileSync('gh', [...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A transient failure worth one more try: a 5xx, a timeout, a reset connection. */
function transient(e: unknown): boolean {
  const text =
    e instanceof Error
      ? `${e.message} ${String((e as { stderr?: unknown }).stderr ?? '')}`
      : String(e);
  return /HTTP 5\d\d|timed? ?out|ECONNRESET|EAI_AGAIN|connection reset/i.test(text);
}

/**
 * A budgeted `gh` client.
 *
 * @param opts - The request budget, and the process runner (tests inject one).
 */
export function createGh(opts: { budget: number; exec?: GhExec }): Gh {
  const exec = opts.exec ?? realExec;
  let calls = 0;
  const spend = (n = 1) => {
    if (calls + n > opts.budget) throw new BudgetExhausted(opts.budget);
    calls += n;
  };
  const withRetry = (args: string[]): string => {
    try {
      return exec(args);
    } catch (e) {
      if (!transient(e)) throw e;
      spend();
      return exec(args);
    }
  };
  return {
    get calls() {
      return calls;
    },
    budget: opts.budget,
    rest(path) {
      spend();
      return JSON.parse(withRetry(['api', path])) as unknown;
    },
    graphql(query) {
      spend();
      return JSON.parse(withRetry(['api', 'graphql', '-f', `query=${query}`])) as unknown;
    },
    remaining() {
      try {
        const r = JSON.parse(exec(['api', 'rate_limit'])) as {
          resources?: { core?: { remaining?: number } };
        };
        return r.resources?.core?.remaining ?? null;
      } catch {
        return null;
      }
    },
    downloadArtifacts(runId, pattern, dir) {
      spend();
      try {
        exec(['run', 'download', String(runId), '-p', pattern, '-D', dir]);
      } catch {
        return 0; // no artifact matched, or they expired: nothing to count
      }
      const n = existsSync(dir) ? readdirSync(dir).length : 0;
      calls += n; // one download request per artifact, on top of the listing
      return n;
    },
  };
}

/** Recorded responses for tests: REST paths and normalised GraphQL queries to JSON. */
export interface Recording {
  rest: Record<string, unknown>;
  /** What `remaining()` answers; unknown when absent. */
  remaining?: number;
  graphql?: Record<string, unknown>;
  /** runId:pattern -> files to write, as relative path -> contents. */
  artifacts?: Record<string, Record<string, string>>;
}

/** Collapse whitespace so a recorded query matches however it was indented. */
export function normaliseQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

/**
 * A client that answers only from a recording and fails loudly on anything
 * else, so a test proves exactly which requests the code makes.
 *
 * @param rec - The recording.
 * @param budget - The budget to enforce, as the real client would.
 * @param write - Writes an artifact file (tests pass `fs.writeFileSync` with mkdir).
 */
export function replayGh(
  rec: Recording,
  budget = 10_000,
  write?: (dir: string, rel: string, text: string) => void
): Gh {
  let calls = 0;
  const spend = (n = 1) => {
    if (calls + n > budget) throw new BudgetExhausted(budget);
    calls += n;
  };
  return {
    get calls() {
      return calls;
    },
    budget,
    rest(path) {
      spend();
      if (!(path in rec.rest)) throw new Error(`no recorded response for GET ${path}`);
      const v = rec.rest[path];
      if (v instanceof Error) throw v;
      return structuredClone(v);
    },
    graphql(query) {
      spend();
      const key = normaliseQuery(query);
      const v = rec.graphql?.[key];
      if (v === undefined) throw new Error(`no recorded response for GraphQL ${key.slice(0, 200)}`);
      return structuredClone(v);
    },
    remaining: () => rec.remaining ?? null,
    downloadArtifacts(runId, pattern, dir) {
      spend();
      const files = rec.artifacts?.[`${runId}:${pattern}`];
      if (!files) return 0;
      const artifacts = new Set<string>();
      for (const [rel, text] of Object.entries(files)) {
        write?.(dir, rel, text);
        artifacts.add(rel.split('/')[0]!);
      }
      calls += artifacts.size;
      return artifacts.size;
    },
  };
}
