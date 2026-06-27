// src/dispatch.ts
var DISPATCHABLE_STATE_CATEGORIES = /* @__PURE__ */ new Set(['backlog', 'unstarted', 'started']);
var DEAD_PROJECT_STATE_CATEGORIES = /* @__PURE__ */ new Set(['completed', 'canceled']);
var AGENT_READY_LABEL = 'agent/ready';
var SIZE_SCALE = {
  xs: 0,
  1: 0,
  sm: 1,
  small: 1,
  2: 1,
  md: 2,
  medium: 2,
  3: 2,
  lg: 3,
  large: 3,
  5: 3,
  xl: 4,
  8: 4,
  xxl: 5,
  13: 5,
};
var PRIORITY_RANK = {
  1: 0,
  // urgent
  2: 1,
  // high
  3: 2,
  // medium
  4: 3,
  // low
  0: 4,
  // none — explicitly last among concrete values
};
var NEUTRAL = Number.POSITIVE_INFINITY;
function isClaimable(cls, ownership) {
  switch (cls) {
    case 'mine':
      return ownership.claimAssignedToAgent;
    case 'unassigned':
      return ownership.claimUnassigned;
    case 'reviewer':
      return ownership.claimAssignedToHuman;
    case 'other':
      return ownership.claimAssignedToOthers;
  }
}
function resolveOwnership(item, opts) {
  const precomputed = opts.ownershipOf?.[item.identifier];
  if (precomputed !== void 0) return precomputed;
  if (opts.classifyOwnership) return opts.classifyOwnership(item);
  throw new Error(
    `dispatch: no ownership for "${item.identifier}" \u2014 provide classifyOwnership or ownershipOf`
  );
}
function hasOpenBlocker(item, openIdentifiers) {
  return item.relations.blockedBy.some((id) => openIdentifiers.has(id));
}
function filterEligible(items, ownership, wipCap, opts) {
  const openIdentifiers = new Set(
    items
      .filter((it) => DISPATCHABLE_STATE_CATEGORIES.has(it.stateCategory))
      .map((it) => it.identifier)
  );
  let globalCount = opts.inProgressTotal ?? 0;
  const perProjectCount = { ...(opts.inProgressByProject ?? {}) };
  const survivors = [];
  for (const item of items) {
    if (!DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory)) continue;
    if (!item.labels.includes(AGENT_READY_LABEL)) continue;
    if (hasOpenBlocker(item, openIdentifiers)) continue;
    if (
      item.project?.stateCategory &&
      DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
    )
      continue;
    if (!isClaimable(resolveOwnership(item, opts), ownership)) continue;
    const projectId = item.project?.id;
    const projectCount = projectId ? (perProjectCount[projectId] ?? 0) : 0;
    if (globalCount >= wipCap.global) continue;
    if (projectId && projectCount >= wipCap.perProject) continue;
    survivors.push(item);
    globalCount += 1;
    if (projectId) perProjectCount[projectId] = projectCount + 1;
  }
  return survivors;
}
function buildOpenSet(items) {
  return new Set(
    items
      .filter((it) => DISPATCHABLE_STATE_CATEGORIES.has(it.stateCategory))
      .map((it) => it.identifier)
  );
}
function unblockerScore(item, openIdentifiers) {
  return item.relations.blocks.filter((id) => openIdentifiers.has(id)).length;
}
function priorityRank(item) {
  if (item.priority === void 0) return NEUTRAL;
  return PRIORITY_RANK[item.priority] ?? NEUTRAL;
}
function projectStatusRank(item) {
  return item.project?.stateCategory === 'started' ? 0 : 1;
}
function sizeRank(item, sizeOrder) {
  if (item.size === void 0) return NEUTRAL;
  const ordinal = SIZE_SCALE[item.size.toLowerCase()];
  if (ordinal === void 0) return NEUTRAL;
  return sizeOrder === 'large-first' ? -ordinal : ordinal;
}
function ageRank(item) {
  if (item.createdAt === void 0) return NEUTRAL;
  const ms = Date.parse(item.createdAt);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}
function typeRank(_item) {
  return 0;
}
function compareByFactor(factor, a, b, openIdentifiers, config) {
  switch (factor) {
    case 'unblockers':
      return unblockerScore(b, openIdentifiers) - unblockerScore(a, openIdentifiers);
    case 'priority':
      return priorityRank(a) - priorityRank(b);
    case 'projectStatus':
      return projectStatusRank(a) - projectStatusRank(b);
    case 'type':
      return typeRank(a) - typeRank(b);
    case 'size':
      return sizeRank(a, config.sizeOrder) - sizeRank(b, config.sizeOrder);
    case 'age':
      return ageRank(a) - ageRank(b);
  }
}
function rankEligible(items, config) {
  const openIdentifiers = buildOpenSet(items);
  return [...items].sort((a, b) => {
    for (const factor of config.rank) {
      const delta = compareByFactor(factor, a, b, openIdentifiers, config);
      if (delta !== 0) return delta;
    }
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}
function selectDispatch(items, config, opts) {
  const eligible = filterEligible(items, config.ownership, config.wipCap, opts);
  return rankEligible(eligible, config.dispatch);
}
function classifyDispatchOutcome(items, config, opts) {
  const picked = selectDispatch(items, config, opts);
  const eligibleCount = picked.length;
  const shapeableCount = items.filter(
    (item) =>
      DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory) &&
      !(
        item.project?.stateCategory && DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
      ) &&
      !item.labels.includes(AGENT_READY_LABEL)
  ).length;
  return {
    picked,
    eligibleCount,
    starved: eligibleCount === 0 && shapeableCount > 0,
    shapeableCount,
  };
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

// cli/dispatch.ts
var HELP = `dispatch \u2014 the /flow dispatch policy (\xA74): eligibility filter + 7-tier ranking ladder.

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
    process.stderr.write(`dispatch: invalid input \u2014 ${err.message}
`);
    return 1;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.items) || !isPlainObject(parsed.config)) {
    process.stderr.write(
      'dispatch: invalid input \u2014 expected { items: WorkItem[], config: {\u2026} }\n'
    );
    return 1;
  }
  const { items, config, opts } = parsed;
  try {
    const outcome = classifyDispatchOutcome(items, config, opts ?? {});
    process.stdout.write(`${JSON.stringify(outcome)}
`);
    return 0;
  } catch (err) {
    process.stderr.write(`dispatch: oracle invariant violation \u2014 ${err.message}
`);
    return 2;
  }
}
if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
export { main };
