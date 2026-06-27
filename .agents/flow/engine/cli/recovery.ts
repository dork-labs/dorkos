/**
 * CLI wrapper over the crash & stall recovery oracle (§12) — the `/flow` engine's
 * next-tick recovery ladder. Reads the orphan signal, the durable {@link FlowRun}
 * record (or `null`), the probe context, and the resolved recovery config from
 * stdin (or `--input <path>`), then emits the {@link RecoveryAction} the runtime
 * should take (skip / resume / restart-clean / escalate / re-derive).
 *
 * Zero-runtime-dep: the oracle's imports are all `import type`, so this bundles
 * to a dependency-free `.mjs`. A `claimed-no-worker` (or `needs-input`) signal
 * with a `null` run is an oracle invariant violation (exit 2) — those signals are
 * only defined for an item that has a local run record.
 *
 * @module @dorkos/flow-engine/cli/recovery
 */

import { recoverOrphan } from '../src/flow-run.js';
import type { FlowRun, OrphanSignal, RecoveryConfig, RecoveryContext } from '../src/flow-run.js';
import { invokedDirectly, isPlainObject, parseArgs, readRawInput } from './_shared.js';

/** The stdin/`--input` payload shape for the recovery script. */
interface RecoveryInput {
  /** The orphan disposition that triggered the sweep. */
  signal: OrphanSignal;
  /** The durable run record, or `null` for the `no-local-record` signal. */
  run: FlowRun | null;
  /** The probe facts the runtime gathered (`worktreeExists`, `sessionLogIntact`). */
  ctx: RecoveryContext;
  /** The resolved recovery config (`maxRetries` / `onExhausted` / `staleAfter`). */
  recovery: RecoveryConfig;
}

const HELP = `recovery — the /flow next-tick recovery ladder (§12): adopt or restart an orphaned run.

Reads JSON from stdin (or --input <path>):
  {
    "signal":   "needs-input" | "claimed-no-worker" | "no-local-record",
    "run":      FlowRun | null,        // null for the "no-local-record" signal
    "ctx":      { "worktreeExists": boolean, "sessionLogIntact": boolean },
    "recovery": RecoveryConfig          // { "maxRetries", "onExhausted", "staleAfter" }
  }

Writes the RecoveryAction as JSON to stdout (discriminated union over "kind"):
  { "kind": "skip"|"resume"|"restart-clean"|"escalate"|"re-derive", … }

Exit codes: 0 ok | 1 invalid input | 2 oracle invariant violation
  (a "claimed-no-worker"/"needs-input" signal with run: null trips the invariant -> exit 2).
`;

/**
 * Run the recovery CLI: parse args, read + structurally validate the JSON
 * payload, evaluate the recovery ladder via {@link recoverOrphan}, and write the
 * resolved action JSON to stdout.
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
    process.stderr.write(`recovery: invalid input — ${(err as Error).message}\n`);
    return 1;
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.signal !== 'string' ||
    !isPlainObject(parsed.ctx) ||
    !isPlainObject(parsed.recovery)
  ) {
    process.stderr.write(
      'recovery: invalid input — expected { signal: string, run: FlowRun|null, ctx: {…}, recovery: {…} }\n'
    );
    return 1;
  }

  const { signal, run, ctx, recovery } = parsed as unknown as RecoveryInput;

  try {
    const action = recoverOrphan(signal, run ?? null, ctx, recovery);
    process.stdout.write(`${JSON.stringify(action)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`recovery: oracle invariant violation — ${(err as Error).message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
