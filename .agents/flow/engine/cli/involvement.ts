/**
 * CLI wrapper over the calibration-ladder oracle (§5) — the single most important
 * behavior in the `/flow` engine: uncertainty-gated (not stage-gated) human
 * involvement. Reads a decision descriptor plus the resolved
 * `involvement.calibration` config from stdin (or `--input <path>`) and emits the
 * {@link InvolvementDecision} — which of the three behaviors to take, whether it
 * blocks the loop, the matched ladder row, and whether to write an assumption
 * trail.
 *
 * Zero-runtime-dep: the oracle's imports are all `import type`, so this bundles
 * to a dependency-free `.mjs`.
 *
 * @module @dorkos/flow-engine/cli/involvement
 */

import { resolveInvolvement } from '../src/calibration.js';
import type { Calibration, DecisionDescriptor } from '../src/calibration.js';
import { invokedDirectly, isPlainObject, parseArgs, readRawInput } from './_shared.js';

/** The stdin/`--input` payload shape for the involvement script. */
interface InvolvementInput {
  /** The evidence-based facts about the decision point (floor / reversibility / confidence / stage). */
  decision: DecisionDescriptor;
  /** The resolved `involvement.calibration` config block that drives every threshold. */
  calibration: Calibration;
}

const HELP = `involvement — the /flow calibration ladder (§5): uncertainty-gated human involvement.

Reads JSON from stdin (or --input <path>):
  {
    "decision": {
      "floorTriggers"?: ("irreversible-or-destructive"|"outward-facing"|"secrets-or-spend"|"scope-change")[],
      "reversibility":  "reversible" | "sticky",
      "confidence":     "confident" | "not-confident",
      "stage":          "intake" | "execution"
    },
    "calibration": Calibration   // the resolved involvement.calibration config block
  }

Writes the InvolvementDecision as JSON to stdout:
  { "behavior": "proceed-silently"|"proceed-with-trail"|"stop-and-ask", "blocks": boolean, "row": number, "logAssumption": boolean }

Exit codes: 0 ok | 1 invalid input | 2 oracle invariant violation.
`;

/**
 * Run the involvement CLI: parse args, read + structurally validate the JSON
 * payload, walk the calibration ladder via {@link resolveInvolvement}, and write
 * the resolved decision JSON to stdout.
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
    process.stderr.write(`involvement: invalid input — ${(err as Error).message}\n`);
    return 1;
  }

  if (
    !isPlainObject(parsed) ||
    !isPlainObject(parsed.decision) ||
    !isPlainObject(parsed.calibration)
  ) {
    process.stderr.write(
      'involvement: invalid input — expected { decision: {…}, calibration: {…} }\n'
    );
    return 1;
  }

  const { decision, calibration } = parsed as unknown as InvolvementInput;

  try {
    const result = resolveInvolvement(decision, calibration);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`involvement: oracle invariant violation — ${(err as Error).message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
