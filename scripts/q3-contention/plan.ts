/**
 * Command-line surface and run plan for the Q3 contention harness (DOR-500).
 *
 * Turns flags into the three PRE-REGISTERED arms and the per-agent assignment
 * (vocabulary → worktree → canary file) that the rest of the harness executes.
 * The arms are fixed by the experimental design in
 * `research/20260724_multi-user-communities.md` (ledger row Q3); this module
 * selects between them, it does not invent new ones.
 *
 * @module scripts/q3-contention/plan
 */

/** Which pre-registered arm to run. */
export type ArmId = 1 | 2 | 3;

/** Vocabulary names, mirroring `Q3_VOCABULARIES` in the server's q3 scenarios. */
export const VOCABULARIES = ['cats', 'dogs', 'birds', 'fish', 'frogs', 'moths'] as const;

/** One vocabulary name. */
export type Vocabulary = (typeof VOCABULARIES)[number];

/** Which throwaway worktree an agent runs in. */
export type TreeId = 'a' | 'b';

/** One agent's assignment for the run. */
export interface AgentPlan {
  readonly index: number;
  readonly vocab: Vocabulary;
  readonly tree: TreeId;
}

/** Fully-resolved run configuration. */
export interface RunPlan {
  readonly arm: ArmId;
  /** True when the arm drives `test-mode` scenarios (arms 1 and 2). */
  readonly testMode: boolean;
  /** Runtime type posted with each turn; only meaningful in arm 3. */
  readonly runtime: string;
  readonly agents: readonly AgentPlan[];
  /** Worktrees the run needs — one for arm 1, two for arms 2 and 3. */
  readonly trees: readonly TreeId[];
  readonly durationMs: number;
  readonly tickMs: number;
  readonly port: number;
  /** Minimum common overlap window that counts as proof, in ms. */
  readonly minOverlapMs: number;
  /** Where CSVs and copies of the canaries land; undefined means the default. */
  readonly outDir: string | undefined;
  /** Keep the throwaway run root on disk after the run. */
  readonly keepRunRoot: boolean;
  /** Skip the `turbo run build --filter=@dorkos/server` step. */
  readonly skipBuild: boolean;
}

/** Default agent count — the "6 agents" half of the Q3 configuration. */
const DEFAULT_AGENTS = 6;
const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_TICK_MS = 500;
const DEFAULT_PORT = 4371;
/** A run must show every agent mid-turn together for at least this long. */
const DEFAULT_MIN_OVERLAP_MS = 2_000;

/** Smoke-run shape: enough to prove the plumbing, too small to be data. */
const SMOKE_AGENTS = 2;
const SMOKE_DURATION_MS = 4_000;
const SMOKE_TICK_MS = 250;
const SMOKE_MIN_OVERLAP_MS = 500;

/** Usage text printed by `--help` — the documented entry point for the harness. */
export const USAGE = `
Q3 contention harness (DOR-500) — measures which resource class collides first
when several agents run concurrent turns on one machine.

  pnpm q3:contention --arm <1|2|3> [options]

Arms (pre-registered — do not add or reinterpret):
  1   test-mode runtime, all agents sharing ONE throwaway worktree
  2   test-mode runtime, agents split across TWO throwaway worktrees (control)
  3   real runtimes, split trees (the only arm exercising subprocess memory
      and provider rate limits — costs real tokens)

Options:
  --arm <n>          Required. 1, 2, or 3.
  --agents <n>       Concurrent agents (default ${DEFAULT_AGENTS}, max ${VOCABULARIES.length}).
  --duration <ms>    How long each turn streams (default ${DEFAULT_DURATION_MS}).
  --tick <ms>        Gap between token yields / canary writes (default ${DEFAULT_TICK_MS}).
  --port <n>         API port for the throwaway server (default ${DEFAULT_PORT}).
  --runtime <type>   Arm 3 only. Runtime to bind sessions to (default claude-code).
  --min-overlap <ms> Common overlap window required to accept the run (default ${DEFAULT_MIN_OVERLAP_MS}).
  --out <dir>        Output directory (default <repo>/.temp/q3-contention/<runId>).
  --keep             Keep the throwaway run root after the run.
  --skip-build       Skip building @dorkos/server before booting.
  --smoke            Plumbing check: ${SMOKE_AGENTS} agents, ${SMOKE_DURATION_MS}ms turns. NOT data.
  --help             Print this.

Arms 1 and 2 are free and repeatable; run them many times for a distribution.
`.trimStart();

/** Read the value following a flag, or undefined when the flag is absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`[q3] ${flag} requires a value`);
  }
  return value;
}

/** Parse a positive-integer flag, falling back to `fallback` when absent. */
function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const raw = flagValue(argv, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[q3] ${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Assign agents to vocabularies and worktrees.
 *
 * Arm 1 puts everyone in tree `a`. Arms 2 and 3 alternate between `a` and `b`,
 * which is what isolates tree-sharing from machine-global effects: the same
 * agent count, the same machine, half the tree contention.
 *
 * @param arm - Which pre-registered arm is running.
 * @param agentCount - How many concurrent agents to plan for.
 * @returns One plan entry per agent.
 * @throws If `agentCount` exceeds the number of distinct vocabularies.
 */
export function planAgents(arm: ArmId, agentCount: number): AgentPlan[] {
  if (agentCount > VOCABULARIES.length) {
    throw new Error(
      `[q3] at most ${VOCABULARIES.length} agents are supported — one per distinct vocabulary, ` +
        `so a crossed stream stays detectable. Requested ${agentCount}.`
    );
  }
  return Array.from({ length: agentCount }, (_, index) => ({
    index,
    vocab: VOCABULARIES[index]!,
    tree: arm === 1 ? ('a' as const) : index % 2 === 0 ? ('a' as const) : ('b' as const),
  }));
}

/**
 * Parse argv into a fully-resolved {@link RunPlan}.
 *
 * @param argv - Arguments after the script name.
 * @returns The run plan, or `null` when `--help` was requested.
 * @throws If `--arm` is missing or any flag is malformed.
 */
export function parseArgs(argv: readonly string[]): RunPlan | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;

  const armRaw = flagValue(argv, '--arm');
  if (armRaw === undefined) throw new Error('[q3] --arm <1|2|3> is required. See --help.');
  const armNumber = Number(armRaw);
  if (armNumber !== 1 && armNumber !== 2 && armNumber !== 3) {
    throw new Error(`[q3] --arm must be 1, 2, or 3 (got "${armRaw}")`);
  }
  const arm: ArmId = armNumber;

  const smoke = argv.includes('--smoke');
  const agentCount = intFlag(argv, '--agents', smoke ? SMOKE_AGENTS : DEFAULT_AGENTS);
  const agents = planAgents(arm, agentCount);

  return {
    arm,
    testMode: arm !== 3,
    runtime: flagValue(argv, '--runtime') ?? 'claude-code',
    agents,
    trees: arm === 1 ? ['a'] : ['a', 'b'],
    durationMs: intFlag(argv, '--duration', smoke ? SMOKE_DURATION_MS : DEFAULT_DURATION_MS),
    tickMs: intFlag(argv, '--tick', smoke ? SMOKE_TICK_MS : DEFAULT_TICK_MS),
    port: intFlag(argv, '--port', DEFAULT_PORT),
    minOverlapMs: intFlag(
      argv,
      '--min-overlap',
      smoke ? SMOKE_MIN_OVERLAP_MS : DEFAULT_MIN_OVERLAP_MS
    ),
    outDir: flagValue(argv, '--out'),
    keepRunRoot: argv.includes('--keep'),
    skipBuild: argv.includes('--skip-build'),
  };
}
