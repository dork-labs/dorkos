// src/calibration.ts
function hasActiveFloorTrigger(floorTriggers, alwaysAsk) {
  if (floorTriggers.length === 0) return false;
  const active = new Set(alwaysAsk);
  return floorTriggers.some((trigger) => active.has(trigger));
}
function proceedWithTrail(row, calibration) {
  return {
    behavior: "proceed-with-trail",
    blocks: false,
    row,
    logAssumption: calibration.assumptionLog.artifact
  };
}
function resolveInvolvement(decision, calibration) {
  const floorTriggers = decision.floorTriggers ?? [];
  if (hasActiveFloorTrigger(floorTriggers, calibration.alwaysAsk)) {
    return {
      behavior: "stop-and-ask",
      blocks: true,
      row: 0 /* Floor */,
      logAssumption: false
    };
  }
  const isReversible = decision.reversibility === "reversible";
  const isConfident = decision.confidence === "confident";
  const silentTags = new Set(calibration.proceedSilentlyWhen);
  if (isReversible && isConfident && silentTags.has("reversible") && silentTags.has("confident")) {
    return {
      behavior: "proceed-silently",
      blocks: false,
      row: 1 /* ReversibleConfident */,
      logAssumption: false
    };
  }
  if (!isReversible && !isConfident) {
    return {
      behavior: "stop-and-ask",
      blocks: true,
      row: 2 /* StickyNotConfident */,
      logAssumption: false
    };
  }
  if (isReversible && !isConfident) {
    const bias = calibration.stageBias[decision.stage];
    if (bias === "ask") {
      return {
        behavior: "stop-and-ask",
        blocks: true,
        row: 3 /* AmbiguousMiddle */,
        logAssumption: false
      };
    }
    return proceedWithTrail(3 /* AmbiguousMiddle */, calibration);
  }
  return proceedWithTrail(4 /* StickyConfident */, calibration);
}

// src/gates.ts
var LABEL_NEEDS_REBASE = "agent/needs-rebase";
var LABEL_BLOCKED = "agent/blocked";
function planApprovalRequired(gates) {
  return gates.planApproval;
}
function tripsCircuitBreaker(usage, circuitBreaker) {
  const wallClockLimit = usage.estimateMs * circuitBreaker.estimateMultiplier;
  if (usage.elapsedMs > wallClockLimit) {
    return { reason: "wall-clock", limit: wallClockLimit, observed: usage.elapsedMs };
  }
  if (usage.tokensUsed > circuitBreaker.tokenBudget) {
    return {
      reason: "token-budget",
      limit: circuitBreaker.tokenBudget,
      observed: usage.tokensUsed
    };
  }
  return null;
}
function routeThroughCalibration(isMechanical, calibration) {
  const descriptor = isMechanical ? { reversibility: "reversible", confidence: "confident", stage: "execution" } : { reversibility: "sticky", confidence: "not-confident", stage: "execution" };
  return resolveInvolvement(descriptor, calibration);
}
function evaluateMergeable(state, review, calibration) {
  if (state.mergeable === "clean") return null;
  const isMechanical = state.mergeable === "conflict-mechanical" && review.onConflict === "resolve-if-mechanical";
  const decision = routeThroughCalibration(isMechanical, calibration);
  if (decision.behavior === "stop-and-ask") {
    return { kind: "bounce", blocks: true, label: LABEL_NEEDS_REBASE, row: decision.row };
  }
  return { kind: "resolve-and-announce", blocks: false, row: decision.row };
}
function evaluateCi(state, review) {
  switch (state.ci) {
    case "green":
      return null;
    case "red-first":
      if (review.ciRetries > 0) {
        return { kind: "retry-ci", blocks: false, retriesRemaining: review.ciRetries };
      }
    // No retries configured — treat a first red exactly like a confirmed red.
    // falls through
    case "red-after-retry":
      return { kind: "re-enter-execute", blocks: false };
  }
}
function evaluateDrift(state, review, calibration) {
  if (state.functionalChange && review.reapproveOnFunctionalChange) {
    const decision = routeThroughCalibration(false, calibration);
    return { kind: "re-request-approval", blocks: true, row: decision.row };
  }
  return { kind: "merge", blocks: false, teardownWorktree: review.teardownWorktree };
}
function evaluateAutoMerge(state, gates, calibration) {
  const { review } = gates;
  if (!review.mergeOnApproval) {
    return { kind: "merge", blocks: false, teardownWorktree: review.teardownWorktree };
  }
  if (state.attemptCount > review.maxMergeAttempts) {
    return {
      kind: "escalate",
      blocks: true,
      label: LABEL_BLOCKED,
      reason: `runaway merge: ${state.attemptCount} attempts exceeds maxMergeAttempts=${review.maxMergeAttempts}`
    };
  }
  const mergeableDisposition = evaluateMergeable(state, review, calibration);
  if (mergeableDisposition) return mergeableDisposition;
  if (review.requireCiGreen) {
    const ciDisposition = evaluateCi(state, review);
    if (ciDisposition) return ciDisposition;
  }
  return evaluateDrift(state, review, calibration);
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

// cli/gates.ts
var HELP = `gates \u2014 the /flow hard gates (\xA75) + auto-merge recovery ladder (\xA76).

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
    process.stderr.write(`gates: invalid input \u2014 ${err.message}
`);
    return 1;
  }
  if (!isPlainObject(parsed) || typeof parsed.gate !== "string") {
    process.stderr.write(
      'gates: invalid input \u2014 expected { gate: "planApproval"|"circuitBreaker"|"autoMerge", \u2026 }\n'
    );
    return 1;
  }
  try {
    const input = parsed;
    switch (input.gate) {
      case "planApproval": {
        process.stdout.write(`${JSON.stringify(planApprovalRequired(input.gates))}
`);
        return 0;
      }
      case "circuitBreaker": {
        const trip = tripsCircuitBreaker(input.usage, input.circuitBreaker);
        process.stdout.write(`${JSON.stringify(trip)}
`);
        return 0;
      }
      case "autoMerge": {
        const disposition = evaluateAutoMerge(input.state, input.gates, input.calibration);
        process.stdout.write(`${JSON.stringify(disposition)}
`);
        return 0;
      }
      default: {
        process.stderr.write(
          `gates: invalid input \u2014 unknown gate "${parsed.gate}"
`
        );
        return 1;
      }
    }
  } catch (err) {
    process.stderr.write(`gates: oracle invariant violation \u2014 ${err.message}
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
