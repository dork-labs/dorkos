// src/calibration.ts
function hasActiveFloorTrigger(floorTriggers, alwaysAsk) {
  if (floorTriggers.length === 0) return false;
  const active = new Set(alwaysAsk);
  return floorTriggers.some((trigger) => active.has(trigger));
}
function proceedWithTrail(row, calibration) {
  return {
    behavior: 'proceed-with-trail',
    blocks: false,
    row,
    logAssumption: calibration.assumptionLog.artifact,
  };
}
function resolveInvolvement(decision, calibration) {
  const floorTriggers = decision.floorTriggers ?? [];
  if (hasActiveFloorTrigger(floorTriggers, calibration.alwaysAsk)) {
    return {
      behavior: 'stop-and-ask',
      blocks: true,
      row: 0 /* Floor */,
      logAssumption: false,
    };
  }
  const isReversible = decision.reversibility === 'reversible';
  const isConfident = decision.confidence === 'confident';
  const silentTags = new Set(calibration.proceedSilentlyWhen);
  if (isReversible && isConfident && silentTags.has('reversible') && silentTags.has('confident')) {
    return {
      behavior: 'proceed-silently',
      blocks: false,
      row: 1 /* ReversibleConfident */,
      logAssumption: false,
    };
  }
  if (!isReversible && !isConfident) {
    return {
      behavior: 'stop-and-ask',
      blocks: true,
      row: 2 /* StickyNotConfident */,
      logAssumption: false,
    };
  }
  if (isReversible && !isConfident) {
    const bias = calibration.stageBias[decision.stage];
    if (bias === 'ask') {
      return {
        behavior: 'stop-and-ask',
        blocks: true,
        row: 3 /* AmbiguousMiddle */,
        logAssumption: false,
      };
    }
    return proceedWithTrail(3 /* AmbiguousMiddle */, calibration);
  }
  return proceedWithTrail(4 /* StickyConfident */, calibration);
}

// cli/_shared.ts
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--input') {
      out.inputPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--input=')) {
      out.inputPath = arg.slice('--input='.length);
    }
  }
  return out;
}
function readRawInput(inputPath) {
  return readFileSync(inputPath ?? 0, 'utf8');
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

// cli/involvement.ts
var HELP = `involvement \u2014 the /flow calibration ladder (\xA75): uncertainty-gated human involvement.

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
    process.stderr.write(`involvement: invalid input \u2014 ${err.message}
`);
    return 1;
  }
  if (
    !isPlainObject(parsed) ||
    !isPlainObject(parsed.decision) ||
    !isPlainObject(parsed.calibration)
  ) {
    process.stderr.write(
      'involvement: invalid input \u2014 expected { decision: {\u2026}, calibration: {\u2026} }\n'
    );
    return 1;
  }
  const { decision, calibration } = parsed;
  try {
    const result = resolveInvolvement(decision, calibration);
    process.stdout.write(`${JSON.stringify(result)}
`);
    return 0;
  } catch (err) {
    process.stderr.write(`involvement: oracle invariant violation \u2014 ${err.message}
`);
    return 2;
  }
}
if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
export { main };
