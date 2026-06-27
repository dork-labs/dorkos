/**
 * CLI wrapper over the gate oracles (§5) + the auto-merge recovery ladder (§6) —
 * the `/flow` engine's config-driven control over when the loop pauses for a
 * human and how an approved-but-stale PR is recovered at merge time. Reads a
 * discriminated `{ gate, … }` payload from stdin (or `--input <path>`), dispatches
 * to the matching oracle, and emits its result verbatim:
 *
 * - `planApproval`   → `planApprovalRequired(gates)` → `boolean`
 * - `circuitBreaker` → `tripsCircuitBreaker(usage, circuitBreaker)` → `CircuitBreakerTrip | null`
 * - `autoMerge`      → `evaluateAutoMerge(state, gates, calibration)` → `MergeDisposition`
 *
 * Zero-runtime-dep: the gate oracles (and the calibration ladder they route
 * through) carry only `import type` cross-module imports, so this bundles to a
 * dependency-free `.mjs`.
 *
 * @module @dorkos/flow-engine/cli/gates
 */

import { evaluateAutoMerge, planApprovalRequired, tripsCircuitBreaker } from '../src/gates.js';
import type { CircuitBreakerConfig, GatesConfig, MergeState, UnitUsage } from '../src/gates.js';
import type { Calibration } from '../src/calibration.js';
import { invokedDirectly, isPlainObject, parseArgs, readRawInput } from './_shared.js';

/** The discriminated stdin/`--input` payload shape for the gates script. */
type GateInput =
  | {
      /** Plan-approval gate (§5/§7.4) — does EXECUTE wait for plan approval? */
      gate: 'planApproval';
      /** The resolved gates config. */
      gates: GatesConfig;
    }
  | {
      /** Circuit breaker (§5/§6) — has the unit exceeded its wall-clock / token budget? */
      gate: 'circuitBreaker';
      /** The unit's measured estimate / elapsed wall-clock / token spend. */
      usage: UnitUsage;
      /** The resolved circuit-breaker thresholds. */
      circuitBreaker: CircuitBreakerConfig;
    }
  | {
      /** Auto-merge recovery ladder (§6) — the disposition for an approved PR at merge time. */
      gate: 'autoMerge';
      /** The approved PR's merge-time facts (mergeable / CI / drift / attempts). */
      state: MergeState;
      /** The resolved gates config (review policy + circuit breaker). */
      gates: GatesConfig;
      /** The resolved `involvement.calibration` block used to route judgement calls. */
      calibration: Calibration;
    };

const HELP = `gates — the /flow hard gates (§5) + auto-merge recovery ladder (§6).

Reads a discriminated JSON payload from stdin (or --input <path>):
  { "gate": "planApproval",   "gates": GatesConfig }
  { "gate": "circuitBreaker", "usage": { "estimateMs", "elapsedMs", "tokensUsed" }, "circuitBreaker": CircuitBreakerConfig }
  { "gate": "autoMerge",      "state": MergeState, "gates": GatesConfig, "calibration": Calibration }

Writes the matching oracle's result as JSON to stdout:
  planApproval   -> boolean
  circuitBreaker -> CircuitBreakerTrip | null   ({ "reason", "limit", "observed" } or null)
  autoMerge      -> MergeDisposition            (discriminated union over "kind")

Exit codes: 0 ok | 1 invalid input | 2 oracle invariant violation.
`;

/**
 * Run the gates CLI: parse args, read + structurally validate the discriminated
 * JSON payload, dispatch to the matching gate oracle, and write its result JSON
 * to stdout.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 ok, 1 invalid input, 2 oracle invariant violation.
 */
export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readRawInput(args.inputPath));
  } catch (err) {
    process.stderr.write(`gates: invalid input — ${(err as Error).message}\n`);
    return 1;
  }

  if (!isPlainObject(parsed) || typeof parsed.gate !== 'string') {
    process.stderr.write(
      'gates: invalid input — expected { gate: "planApproval"|"circuitBreaker"|"autoMerge", … }\n'
    );
    return 1;
  }

  try {
    const input = parsed as unknown as GateInput;
    switch (input.gate) {
      case 'planApproval': {
        process.stdout.write(`${JSON.stringify(planApprovalRequired(input.gates))}\n`);
        return 0;
      }
      case 'circuitBreaker': {
        const trip = tripsCircuitBreaker(input.usage, input.circuitBreaker);
        process.stdout.write(`${JSON.stringify(trip)}\n`);
        return 0;
      }
      case 'autoMerge': {
        const disposition = evaluateAutoMerge(input.state, input.gates, input.calibration);
        process.stdout.write(`${JSON.stringify(disposition)}\n`);
        return 0;
      }
      default: {
        process.stderr.write(
          `gates: invalid input — unknown gate "${(parsed as { gate: string }).gate}"\n`
        );
        return 1;
      }
    }
  } catch (err) {
    process.stderr.write(`gates: oracle invariant violation — ${(err as Error).message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
