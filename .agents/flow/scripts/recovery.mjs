// src/flow-run.ts
var RECOVERY_BLOCKED_LABEL = "agent/blocked";
function checkpointResumable(ctx) {
  return ctx.worktreeExists && ctx.sessionLogIntact;
}
function recoverOrphan(signal, run, ctx, recovery) {
  if (signal === "needs-input") {
    return { kind: "skip", reason: "parked-on-human" };
  }
  if (signal === "no-local-record") {
    return { kind: "re-derive", reason: "no-local-record" };
  }
  if (run === null || run === void 0) {
    throw new Error(
      `recoverOrphan: signal "${signal}" requires a local FlowRun, but none was provided`
    );
  }
  if (run.attemptCount >= recovery.maxRetries) {
    return {
      kind: "escalate",
      label: RECOVERY_BLOCKED_LABEL,
      reason: `recovery retries exhausted (attemptCount ${run.attemptCount} >= maxRetries ${recovery.maxRetries})`
    };
  }
  const attemptCount = run.attemptCount + 1;
  if (checkpointResumable(ctx)) {
    return { kind: "resume", attemptCount };
  }
  return {
    kind: "restart-clean",
    reason: ctx.worktreeExists ? "session-log-corrupt" : "no-worktree",
    attemptCount
  };
}

// cli/_shared.ts
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--input") {
      out.inputPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--input=")) {
      out.inputPath = arg.slice("--input=".length);
    }
  }
  return out;
}
function readRawInput(inputPath) {
  return readFileSync(inputPath ?? 0, "utf8");
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invokedDirectly(metaUrl) {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

// cli/recovery.ts
var HELP = `recovery \u2014 the /flow next-tick recovery ladder (\xA712): adopt or restart an orphaned run.

Reads JSON from stdin (or --input <path>):
  {
    "signal":   "needs-input" | "claimed-no-worker" | "no-local-record",
    "run":      FlowRun | null,        // null for the "no-local-record" signal
    "ctx":      { "worktreeExists": boolean, "sessionLogIntact": boolean },
    "recovery": RecoveryConfig          // { "maxRetries", "onExhausted", "staleAfter" }
  }

Writes the RecoveryAction as JSON to stdout (discriminated union over "kind"):
  { "kind": "skip"|"resume"|"restart-clean"|"escalate"|"re-derive", \u2026 }

Exit codes: 0 ok | 1 invalid input | 2 oracle invariant violation
  (a "claimed-no-worker"/"needs-input" signal with run: null trips the invariant -> exit 2).
`;
function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(readRawInput(args.inputPath));
  } catch (err) {
    process.stderr.write(`recovery: invalid input \u2014 ${err.message}
`);
    return 1;
  }
  if (!isPlainObject(parsed) || typeof parsed.signal !== "string" || !isPlainObject(parsed.ctx) || !isPlainObject(parsed.recovery)) {
    process.stderr.write(
      "recovery: invalid input \u2014 expected { signal: string, run: FlowRun|null, ctx: {\u2026}, recovery: {\u2026} }\n"
    );
    return 1;
  }
  const { signal, run, ctx, recovery } = parsed;
  try {
    const action = recoverOrphan(signal, run ?? null, ctx, recovery);
    process.stdout.write(`${JSON.stringify(action)}
`);
    return 0;
  } catch (err) {
    process.stderr.write(`recovery: oracle invariant violation \u2014 ${err.message}
`);
    return 2;
  }
}
if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
export {
  main
};
