/**
 * CLI wrapper over the dispatch-policy oracle (§4) — the `/flow` engine's answer
 * to "what should I work on next?". Reads a candidate set plus the resolved
 * dispatch / ownership / WIP config from stdin (or `--input <path>`) and emits the
 * typed {@link classifyDispatchOutcome | DispatchOutcome}: the ranked, eligible
 * pick list plus the starvation signals (`eligibleCount`, `starved`,
 * `shapeableCount`) the loop uses to tell "genuinely done" from "starved behind
 * the `agent/ready` gate".
 *
 * Zero-runtime-dep: the oracle's cross-module imports are all `import type`, so
 * this bundles to a dependency-free `.mjs`. Ownership cannot cross the JSON
 * boundary as a callback, so callers pass a precomputed `opts.ownershipOf` map
 * rather than `opts.classifyOwnership`.
 *
 * @module @dorkos/flow-engine/cli/dispatch
 */

import { classifyDispatchOutcome } from '../src/dispatch.js';
import type { DispatchConfig, DispatchOptions, OwnershipConfig, WipCap } from '../src/dispatch.js';
import type { WorkItem } from '../src/work-item.js';
import { invokedDirectly, isPlainObject, parseArgs, readRawInput } from './_shared.js';

/** The stdin/`--input` payload shape for the dispatch script. */
interface DispatchInput {
  /** The candidate work items (from the adapter's `getEligibleWork`). */
  items: WorkItem[];
  /** The resolved dispatch / ownership / WIP config blocks. */
  config: { dispatch: DispatchConfig; ownership: OwnershipConfig; wipCap: WipCap };
  /** Ownership resolution (`ownershipOf` map) + live WIP counts. Optional. */
  opts?: DispatchOptions;
}

const HELP = `dispatch — the /flow dispatch policy (§4): eligibility filter + 7-tier ranking ladder.

Reads JSON from stdin (or --input <path>):
  {
    "items":  WorkItem[],
    "config": { "dispatch": DispatchConfig, "ownership": OwnershipConfig, "wipCap": WipCap },
    "opts"?:  {
      "ownershipOf"?:         { "<identifier>": "mine" | "reviewer" | "other" | "unassigned" },
      "inProgressByProject"?: { "<projectId>": number },
      "inProgressTotal"?:     number
    }
  }

Writes the DispatchOutcome as JSON to stdout:
  { "picked": WorkItem[], "eligibleCount": number, "starved": boolean, "shapeableCount": number }

Exit codes: 0 ok | 1 invalid input | 2 oracle invariant violation.
`;

/**
 * Run the dispatch CLI: parse args, read + structurally validate the JSON
 * payload, invoke {@link classifyDispatchOutcome} (which runs the full
 * `selectDispatch` policy), and write the outcome JSON to stdout.
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
    process.stderr.write(`dispatch: invalid input — ${(err as Error).message}\n`);
    return 1;
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.items) || !isPlainObject(parsed.config)) {
    process.stderr.write('dispatch: invalid input — expected { items: WorkItem[], config: {…} }\n');
    return 1;
  }

  const { items, config, opts } = parsed as unknown as DispatchInput;

  try {
    const outcome = classifyDispatchOutcome(items, config, opts ?? {});
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`dispatch: oracle invariant violation — ${(err as Error).message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
