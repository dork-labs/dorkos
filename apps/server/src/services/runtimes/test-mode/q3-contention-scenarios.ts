import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from './scenario-store.js';
import { DEMO_MODEL, DEMO_SESSION_ID, delay } from './demo-scenario-shared.js';
import { env } from '../../../env.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';

/**
 * The `q3-*` scenario family: long-running, filesystem-contending test-mode
 * turns built for ONE measurement — the Q3 question, pre-registered in
 * `research/20260725_q3-contention-preregistration.md`: at 2 humans and 6
 * agents on one machine, WHICH resource class collides first?
 *
 * Three properties the built-in and `demo-*` scenarios deliberately lack:
 *
 *  1. **Distinguishable vocabularies.** Each scenario streams tokens drawn from
 *     one disjoint word list and prefixes every token with its vocabulary name
 *     (`cats:TABBY#00007`). Two agents' streams can never be confused, so a
 *     crossed stream is detectable by inspection or by `grep`.
 *  2. **Configurable wall-clock duration.** A zero-latency scenario cannot
 *     produce overlapping turns, and non-overlapping turns measure nothing.
 *     `DORKOS_Q3_DURATION_MS` holds the turn open for tens of seconds.
 *  3. **An interleave detector.** Between yields each scenario performs a
 *     deliberately non-atomic read-modify-write against a shared canary file:
 *     read the whole file, append one tagged line, write it back. Concurrent
 *     agents WILL clobber each other's lines, and counting the survivors is the
 *     measurement. Read the caveat in {@link readModifyWriteCanary} before
 *     quoting any number this produces: it detects INTERLEAVING, not the data
 *     loss a real agent would suffer.
 *
 * Purely additive: nothing here changes the behavior of the built-in or
 * `demo-*` scenarios the marketing product-capture pipeline depends on. The
 * family is inert unless `DORKOS_TEST_RUNTIME=true` registers
 * {@link TestModeRuntime} AND a `q3-*` name is bound to a session via
 * `POST /api/test/scenario`.
 *
 * The orchestration side — throwaway `DORK_HOME`, throwaway worktrees,
 * concurrent turn firing, 1 Hz sampling, overlap proof, canary accounting —
 * lives in `scripts/q3-contention/`.
 *
 * @module services/runtimes/test-mode/q3-contention-scenarios
 */

/**
 * Disjoint token vocabularies, one per concurrent agent. Every token is short,
 * upper-case, and appears in exactly one list, so a token found in the wrong
 * session's transcript is unambiguous evidence of a crossed stream.
 */
export const Q3_VOCABULARIES = {
  cats: ['TABBY', 'CALICO', 'SIAMESE', 'RAGDOLL', 'SPHYNX', 'BENGAL'],
  dogs: ['BEAGLE', 'CORGI', 'HUSKY', 'POODLE', 'BOXER', 'COLLIE'],
  birds: ['FINCH', 'HERON', 'KESTREL', 'MAGPIE', 'PUFFIN', 'WREN'],
  fish: ['TETRA', 'GUPPY', 'TARPON', 'WRASSE', 'MARLIN', 'PLAICE'],
  frogs: ['PEEPER', 'BULLFROG', 'TREEFROG', 'GOLIATH', 'DARTFROG', 'PICKEREL'],
  moths: ['LUNA', 'ATLAS', 'CECROPIA', 'HAWKMOTH', 'TIGERMOTH', 'IOMOTH'],
} as const satisfies Record<string, readonly string[]>;

/** Name of one {@link Q3_VOCABULARIES} entry (also the scenario's suffix). */
export type Q3Vocabulary = keyof typeof Q3_VOCABULARIES;

/** Every vocabulary name, in the order the harness assigns them to agents. */
export const Q3_VOCABULARY_NAMES = Object.keys(Q3_VOCABULARIES) as Q3Vocabulary[];

/** Scenario name for a vocabulary — the key `POST /api/test/scenario` takes. */
export function q3ScenarioName(vocab: Q3Vocabulary): string {
  return `q3-${vocab}`;
}

/** Marker line the harness parses for the agent-reported turn start. */
const START_MARKER = '[q3-start]';

/** Marker line the harness parses for the agent-reported turn end + counts. */
const SUMMARY_MARKER = '[q3-summary]';

/** Shape of `DORKOS_Q3_CANARY_MAP`: vocabulary name → absolute canary path. */
const canaryMapSchema = z.record(z.string(), z.string());

/**
 * Reject a canary path that is not absolute or that lives under a directory the
 * harness must never write into. The forbidden roots are the ACTIVE DorkOS home
 * (whatever `DORK_HOME` resolves to) and the operator's real `~/.dork` — a
 * measurement that corrupts either would be worse than no measurement.
 *
 * @param candidate - Canary path from the environment.
 * @param forbiddenRoots - Absolute directories the path may not sit inside.
 * @throws If the path is relative or contained by a forbidden root.
 */
function assertSafeCanaryPath(candidate: string, forbiddenRoots: readonly string[]): void {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`[q3] canary path must be absolute, got "${candidate}"`);
  }
  const resolved = path.resolve(candidate);
  for (const root of forbiddenRoots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`[q3] canary path "${resolved}" is inside a protected directory "${root}"`);
    }
  }
}

/**
 * Parse and validate `DORKOS_Q3_CANARY_MAP` into a vocabulary → path lookup.
 *
 * Kept pure (raw string + explicit forbidden roots) so the safety guard is
 * testable without an environment.
 *
 * @param raw - JSON object string, or undefined to disable filesystem contention.
 * @param forbiddenRoots - Absolute directories no canary may sit inside.
 * @returns Map from vocabulary name to absolute canary path; empty when `raw` is absent.
 * @throws If the JSON is invalid, a key is not a known vocabulary, or a path fails the guard.
 * @internal Exported for testing.
 */
export function parseCanaryMap(
  raw: string | undefined,
  forbiddenRoots: readonly string[]
): ReadonlyMap<string, string> {
  if (!raw) return new Map();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    // The SyntaxError names the offset it choked on, which is the only part of
    // this that helps when the value came from a shell one-liner.
    throw new Error('[q3] DORKOS_Q3_CANARY_MAP is not valid JSON', { cause: err });
  }
  const parsed = canaryMapSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('[q3] DORKOS_Q3_CANARY_MAP must be an object of string → string');
  }
  const out = new Map<string, string>();
  for (const [vocab, candidate] of Object.entries(parsed.data)) {
    if (!(vocab in Q3_VOCABULARIES)) {
      throw new Error(
        `[q3] unknown vocabulary "${vocab}" in DORKOS_Q3_CANARY_MAP; known: ${Q3_VOCABULARY_NAMES.join(', ')}`
      );
    }
    assertSafeCanaryPath(candidate, forbiddenRoots);
    out.set(vocab, path.resolve(candidate));
  }
  return out;
}

/** Directories a canary file may never live inside. */
function forbiddenCanaryRoots(): string[] {
  const roots = [resolveDorkHome()];
  // The operator's real `~/.dork`, which `resolveDorkHome()` does NOT return
  // once DORK_HOME points at a throwaway home. `env.HOME` is the resolved-home
  // source available to server code (`os.homedir()` is banned, Hard Rule #3).
  if (env.HOME) roots.push(path.join(env.HOME, '.dork'));
  return roots.map((root) => path.resolve(root));
}

/** Per-turn configuration, resolved once per scenario invocation. */
interface Q3Config {
  readonly durationMs: number;
  readonly tickMs: number;
  readonly canaryPaths: ReadonlyMap<string, string>;
}

/**
 * Read the q3 knobs off the parse-once server environment. Resolved once per
 * turn (not per tick) so the JSON parse and path guard never sit on the hot
 * loop being measured.
 */
function resolveQ3Config(): Q3Config {
  return {
    durationMs: env.DORKOS_Q3_DURATION_MS,
    tickMs: env.DORKOS_Q3_TICK_MS,
    canaryPaths: parseCanaryMap(env.DORKOS_Q3_CANARY_MAP, forbiddenCanaryRoots()),
  };
}

/**
 * Append one line to the canary the slow way, on purpose: read the WHOLE file,
 * concatenate, write the whole thing back. There is no append mode, no lock,
 * and no atomic rename — two agents interleaving here lose each other's lines.
 *
 * WHAT THIS MEASURES, PRECISELY. This is an **interleave detector**, not a
 * corruption meter. A shortfall proves concurrent whole-file rewrites
 * interleaved and clobbered each other. It is NOT the data loss real agent
 * tooling would suffer: a writer using temp-file-plus-atomic-rename (the
 * pattern DorkOS's own marketplace install transaction uses, ADR-0304) loses
 * NOTHING on this exact workload. Quoting a canary shortfall as a corruption
 * rate for real agents misuses it. The caveat rides into `summary.json` on
 * every run (`CanaryReport.method` / `.caveat`) so it cannot be separated from
 * the number it qualifies.
 */
async function readModifyWriteCanary(file: string, line: string): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(file, `${existing}${line}\n`, 'utf8');
}

/**
 * Build the scenario for one vocabulary: stream tagged tokens for the
 * configured duration, doing one canary read-modify-write between yields, and
 * close with a machine-readable summary the harness parses.
 *
 * The `[q3-start]` / `[q3-summary]` markers carry timestamps taken INSIDE the
 * server process, so every agent's interval is measured on one clock — the
 * harness's overlap proof does not depend on its own request latency.
 */
function buildQ3Scenario(vocab: Q3Vocabulary): ScenarioFn {
  return async function* q3Scenario(_content: string): AsyncGenerator<StreamEvent> {
    const config = resolveQ3Config();
    const canaryPath = config.canaryPaths.get(vocab);
    const words = Q3_VOCABULARIES[vocab];
    const startedAt = Date.now();
    const deadline = startedAt + config.durationMs;

    yield {
      type: 'session_status',
      data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
    } as StreamEvent;
    yield {
      type: 'text_delta',
      data: { text: `${START_MARKER} vocab=${vocab} startedAt=${startedAt}\n` },
    } as StreamEvent;

    let ticks = 0;
    let appends = 0;
    let canaryErrors = 0;
    while (Date.now() < deadline) {
      const word = words[ticks % words.length];
      const counter = String(ticks).padStart(5, '0');
      yield {
        type: 'text_delta',
        data: { text: `${vocab}:${word}#${counter} ` },
      } as StreamEvent;

      if (canaryPath) {
        try {
          await readModifyWriteCanary(canaryPath, `${vocab} ${ticks} ${new Date().toISOString()}`);
          appends++;
        } catch {
          // Counted, not thrown: an EMFILE or EIO here IS a result, and losing
          // the rest of the turn would destroy the sample it belongs to.
          canaryErrors++;
        }
      }

      ticks++;
      await delay(config.tickMs);
    }

    yield {
      type: 'text_delta',
      data: {
        text:
          `\n${SUMMARY_MARKER} vocab=${vocab} startedAt=${startedAt} endedAt=${Date.now()} ` +
          `ticks=${ticks} appends=${appends} canaryErrors=${canaryErrors}\n`,
      },
    } as StreamEvent;
    yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
  };
}

/**
 * The `q3-*` scenarios, keyed by scenario name. Spread into the test-mode
 * scenario registry alongside the built-in and `demo-*` families.
 */
export const Q3_SCENARIOS: Record<string, ScenarioFn> = Object.fromEntries(
  Q3_VOCABULARY_NAMES.map((vocab) => [q3ScenarioName(vocab), buildQ3Scenario(vocab)])
);
