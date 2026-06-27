#!/usr/bin/env node
// @ts-check
/*
 * validate-adapter.mjs - the /flow tracker-adapter conformance harness.
 *
 * Asserts the five conformance invariants from .agents/flow/adapters/SPEC.md
 * section 4 (INV-1 .. INV-5) against a fixture of NORMALIZED WorkItems - the
 * output an adapter's read verbs produce. The fixture is tracker-neutral: it
 * holds only normalized WorkItems, never a tracker API string.
 *
 * This script is dependency-free by design (no zod, no imports beyond node:fs /
 * node:url). The invariants are hand-rolled so the harness ships with the /flow
 * plugin from one canonical source, exactly like the other oracle scripts in
 * this directory (ADR-0294). Keep it in lockstep with:
 *   - .agents/flow/adapters/SPEC.md section 4 (the normative invariants), and
 *   - .agents/flow/skills/building-adapters/references/conformance-harness.md
 *     (the operational guide that documents this exact interface).
 *
 * Interface (matches the building-adapters skill doc exactly):
 *   node scripts/validate-adapter.mjs --fixture <path-to-fixture.json>
 *   node scripts/validate-adapter.mjs                 # reads the fixture on stdin
 *   node scripts/validate-adapter.mjs --help          # prints the contract, exit 0
 *
 * Output (stdout): a JSON verdict { "ok": boolean, "failures": [{ "invariant", "detail" }] }.
 * Exit codes: 0 pass (ok:true) | 1 invariant failure (ok:false) | 2 invalid input.
 * Diagnostics go to stderr; stdout is always the JSON verdict.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The five workflow-state categories - the ONLY categories an adapter may emit (INV-1). */
const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];

/** The seven mutually-exclusive WorkItem types, sourced from the `type/*` label family. */
const WORK_ITEM_TYPES = ['idea', 'research', 'hypothesis', 'task', 'monitor', 'signal', 'meta'];

/** The four agent dispositions, derived from the durable `agent/*` label family. */
const AGENT_DISPOSITIONS = ['ready', 'claimed', 'completed', 'needs-input'];

/** The literal, re-namespaced readiness label that gates dispatch (INV-5). */
const AGENT_READY_LABEL = 'agent/ready';

/** The optional WorkItem fields. A missing optional MUST be absent (undefined), never null/fabricated. */
const OPTIONAL_FIELDS = [
  'priority',
  'size',
  'project',
  'assignee',
  'agentDisposition',
  'createdAt',
];

const HELP = `validate-adapter - the /flow tracker-adapter conformance harness.

Asserts the five conformance invariants in .agents/flow/adapters/SPEC.md section 4
against a fixture of NORMALIZED WorkItems (an adapter's read-verb output). The
fixture is tracker-neutral: normalized WorkItems only, no tracker API strings.

Usage:
  node scripts/validate-adapter.mjs --fixture <path-to-fixture.json>
  node scripts/validate-adapter.mjs                  reads the fixture on stdin
  node scripts/validate-adapter.mjs --help           prints this and exits 0

Fixture: a JSON array of WorkItems, or { "items": [ ...WorkItems ] }.

Verdict (stdout): { "ok": boolean, "failures": [{ "invariant": "INV-N", "detail": "..." }] }
  ok:       false when any invariant failed.
  failures: one entry per breached invariant (empty when ok).

Exit codes: 0 pass (ok:true) | 1 invariant failure (ok:false) | 2 invalid input.

Invariants:
  INV-1  All five stateCategory values are representable; no sixth category is
         ever emitted (a holding / un-triaged state normalizes to backlog).
  INV-2  Required fields are present and correctly typed; optionals are absent
         or correctly typed (a missing optional is undefined, never fabricated).
  INV-3  Relation references are human-key identifiers, never tracker-native ids;
         an out-of-set reference is treated as closed/non-blocking (neutral).
  INV-4  Labels are re-namespaced into the generic families (agent/*, stage/*,
         type/*, ...); a bare tracker-native leaf label fails.
  INV-5  Readiness is expressed ONLY as the literal agent/ready label, never as a
         bare leaf or a separate field. The candidate set deliberately includes
         not-ready shapeable items (so starvation is detectable); those do NOT
         fail - the engine's eligibility pass, not the adapter, drops them.
`;

/** True for a non-array, non-null object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a string with at least one character. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** True for an array whose every element is a string. */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A short, safe label for an item in failure details (its human key, or its index). */
function itemLabel(item, index) {
  if (isPlainObject(item) && isNonEmptyString(item.identifier)) return item.identifier;
  return `item[${index}]`;
}

/**
 * Heuristic: does `value` look like a tracker-NATIVE id rather than a human-key
 * identifier? Relation arrays carry identifiers (human keys); native ids leaking
 * into them is the INV-3 breach. Two signals, the first definitive:
 *   1. It equals some in-set item's native `id` while differing from that item's
 *      `identifier` - a provable native-id leak, tracker-neutral.
 *   2. It matches a shape no human key ever takes (underscore, UUID, long hex).
 */
function looksLikeNativeId(value, items) {
  for (const it of items) {
    if (isPlainObject(it) && it.id === value && it.identifier !== value) return true;
  }
  if (value.includes('_')) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^[0-9a-f]{24,}$/i.test(value)) return true;
  return false;
}

/**
 * INV-1 - all five state categories are representable; no sixth is emitted.
 * Returns an array of breach detail strings (empty = pass).
 */
function checkInv1(items) {
  const details = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    if (typeof item.stateCategory === 'string' && !STATE_CATEGORIES.includes(item.stateCategory)) {
      details.push(
        `${itemLabel(item, index)} has stateCategory "${item.stateCategory}", not one of ${STATE_CATEGORIES.join(' | ')}`
      );
    }
    if (
      isPlainObject(item.project) &&
      typeof item.project.stateCategory === 'string' &&
      !STATE_CATEGORIES.includes(item.project.stateCategory)
    ) {
      details.push(
        `${itemLabel(item, index)} has project.stateCategory "${item.project.stateCategory}", not one of the five`
      );
    }
  });
  return details;
}

/**
 * INV-2 - required fields present and correctly typed; optionals absent or typed.
 * Returns an array of breach detail strings (empty = pass).
 */
function checkInv2(items) {
  const details = [];
  items.forEach((item, index) => {
    const label = itemLabel(item, index);
    if (!isPlainObject(item)) {
      details.push(`${label} is not an object`);
      return;
    }

    // Required string fields.
    if (!isNonEmptyString(item.id)) details.push(`${label} field "id" must be a non-empty string`);
    if (!isNonEmptyString(item.identifier))
      details.push(`${label} field "identifier" must be a non-empty string`);
    if (typeof item.title !== 'string') details.push(`${label} field "title" must be a string`);
    if (typeof item.description !== 'string')
      details.push(`${label} field "description" must be a string`);
    if (typeof item.stateName !== 'string')
      details.push(`${label} field "stateName" must be a string`);

    // Required enums (membership owned by INV-1 for stateCategory; here we check presence + enum for type).
    if (!WORK_ITEM_TYPES.includes(item.type))
      details.push(`${label} field "type" must be one of ${WORK_ITEM_TYPES.join(' | ')}`);
    if (typeof item.stateCategory !== 'string')
      details.push(`${label} field "stateCategory" must be a string`);

    // parent: string | null (never "" - an empty string is a fabricated stand-in for null).
    if (!(item.parent === null || isNonEmptyString(item.parent)))
      details.push(`${label} field "parent" must be a non-empty string or null`);

    // relations: object with string[] arrays + optional string duplicateOf.
    if (!isPlainObject(item.relations)) {
      details.push(`${label} field "relations" must be an object`);
    } else {
      for (const key of ['blocks', 'blockedBy', 'children', 'relatedTo']) {
        if (!isStringArray(item.relations[key]))
          details.push(`${label} relations.${key} must be a string[]`);
      }
      if (
        item.relations.duplicateOf !== undefined &&
        typeof item.relations.duplicateOf !== 'string'
      )
        details.push(`${label} relations.duplicateOf must be a string when present`);
    }

    // labels: string[].
    if (!isStringArray(item.labels)) details.push(`${label} field "labels" must be a string[]`);

    // Optionals: when present, never null (a missing optional is absent, not null) and correctly typed.
    for (const field of OPTIONAL_FIELDS) {
      if (!(field in item)) continue;
      const value = item[field];
      if (value === null) {
        details.push(
          `${label} optional "${field}" is null; a missing optional must be absent, not null`
        );
        continue;
      }
      if (value === undefined) continue;
      if (field === 'priority' && !(Number.isInteger(value) && value >= 0 && value <= 4))
        details.push(`${label} optional "priority" must be an integer in {0,1,2,3,4}`);
      if (field === 'size' && !isNonEmptyString(value))
        details.push(`${label} optional "size" must be a non-empty string`);
      if (field === 'assignee' && !isNonEmptyString(value))
        details.push(`${label} optional "assignee" must be a non-empty string`);
      if (field === 'createdAt' && typeof value !== 'string')
        details.push(`${label} optional "createdAt" must be a string`);
      if (field === 'agentDisposition' && !AGENT_DISPOSITIONS.includes(value))
        details.push(
          `${label} optional "agentDisposition" must be one of ${AGENT_DISPOSITIONS.join(' | ')}`
        );
      if (field === 'project') {
        if (!isPlainObject(value)) {
          details.push(`${label} optional "project" must be an object`);
        } else {
          if (!isNonEmptyString(value.id))
            details.push(`${label} project.id must be a non-empty string`);
          if (typeof value.name !== 'string')
            details.push(`${label} project.name must be a string`);
        }
      }
    }
  });
  return details;
}

/**
 * INV-3 - relation references resolve. Every id in blocks/blockedBy/children/
 * relatedTo/duplicateOf is a human-key identifier, never a native id. An
 * out-of-set human-key reference is treated as closed/out-of-scope (neutral) and
 * does NOT fail; only a native-id-shaped reference fails.
 * Returns an array of breach detail strings (empty = pass).
 */
function checkInv3(items) {
  const details = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !isPlainObject(item.relations)) return;
    const label = itemLabel(item, index);
    const relations = item.relations;
    for (const key of ['blocks', 'blockedBy', 'children', 'relatedTo']) {
      const refs = relations[key];
      if (!isStringArray(refs)) continue; // structural typing is INV-2's job
      for (const ref of refs) {
        if (looksLikeNativeId(ref, items))
          details.push(
            `${label} relations.${key} contains "${ref}", which has a native-id shape (relations must carry human-key identifiers, never native ids)`
          );
      }
    }
    if (
      typeof relations.duplicateOf === 'string' &&
      looksLikeNativeId(relations.duplicateOf, items)
    )
      details.push(
        `${label} relations.duplicateOf "${relations.duplicateOf}" has a native-id shape (must be a human-key identifier)`
      );
  });
  return details;
}

/**
 * INV-4 - labels are re-namespaced into the generic families. Every label is in
 * `family/leaf` form (a bare native leaf fails); `type` traces to a `type/*`
 * label and `agentDisposition` traces to the matching `agent/*` label.
 * Returns an array of breach detail strings (empty = pass).
 */
function checkInv4(items) {
  const details = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !isStringArray(item.labels)) return;
    const label = itemLabel(item, index);
    const labels = item.labels;

    // Every label must be namespaced (family/leaf). A bare leaf is a native label leak.
    for (const lbl of labels) {
      if (!/^[^/]+\/.+$/.test(lbl))
        details.push(
          `${label} carries bare label "${lbl}" (labels must be re-namespaced into a generic family/leaf form, e.g. agent/ready)`
        );
    }

    // type must trace to a type/<type> label.
    if (WORK_ITEM_TYPES.includes(item.type) && !labels.includes(`type/${item.type}`))
      details.push(
        `${label} has type "${item.type}" but no matching "type/${item.type}" label (type must derive from the type/* family)`
      );

    // agentDisposition, when present, must trace to the matching agent/<disposition> label.
    if (
      AGENT_DISPOSITIONS.includes(item.agentDisposition) &&
      !labels.includes(`agent/${item.agentDisposition}`)
    )
      details.push(
        `${label} has agentDisposition "${item.agentDisposition}" but no matching "agent/${item.agentDisposition}" label (disposition must derive from the agent/* family)`
      );
  });
  return details;
}

/**
 * INV-5 - the readiness gate is the agent/ready label. Readiness is expressed
 * ONLY as the literal agent/ready label, never as a bare leaf or a separate
 * field. We assert (a) any item presenting as ready (agentDisposition === 'ready')
 * carries the literal agent/ready label, and (b) no item carries a bare-leaf
 * readiness label ("ready"). We deliberately do NOT fail items that merely lack
 * agent/ready: the candidate set includes shapeable not-ready work so the loop
 * can distinguish done from starved.
 * Returns an array of breach detail strings (empty = pass).
 */
function checkInv5(items) {
  const details = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !isStringArray(item.labels)) return;
    const label = itemLabel(item, index);
    const labels = item.labels;

    // (a) Readiness must be the label, not just the field.
    if (item.agentDisposition === 'ready' && !labels.includes(AGENT_READY_LABEL))
      details.push(
        `${label} presents as ready (agentDisposition "ready") but lacks the "${AGENT_READY_LABEL}" label; readiness must be the label, never a separate field (the gate matches the label and would silently skip this item)`
      );

    // (b) The readiness signal must never appear as a bare leaf.
    if (labels.includes('ready'))
      details.push(
        `${label} carries the bare-leaf label "ready"; the readiness signal must be the re-namespaced "${AGENT_READY_LABEL}" label, or the dispatch gate silently fails to match it`
      );
  });
  return details;
}

/**
 * Run all five invariant checks over the normalized WorkItems and assemble the
 * verdict. One failures[] entry per breached invariant (details aggregated).
 */
function validate(items) {
  const checks = [
    ['INV-1', checkInv1],
    ['INV-2', checkInv2],
    ['INV-3', checkInv3],
    ['INV-4', checkInv4],
    ['INV-5', checkInv5],
  ];
  const failures = [];
  for (const [invariant, check] of checks) {
    const details = check(items);
    if (details.length > 0) failures.push({ invariant, detail: details.join('; ') });
  }
  return { ok: failures.length === 0, failures };
}

/** Parse argv into { help, fixturePath }. Accepts --fixture <path> and --fixture=<path>. */
function parseArgs(argv) {
  const out = { help: false, fixturePath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--fixture') {
      out.fixturePath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--fixture=')) {
      out.fixturePath = arg.slice('--fixture='.length);
    }
  }
  return out;
}

/** Read the raw fixture text from the given path, or from stdin (fd 0) when absent. */
function readRawInput(fixturePath) {
  return readFileSync(fixturePath ?? 0, 'utf8');
}

/** Coerce a parsed fixture (array, or { items: [...] }) into a WorkItem array, or throw. */
function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed) && Array.isArray(parsed.items)) return parsed.items;
  throw new Error('fixture must be a JSON array of WorkItems, or an object { "items": [ ... ] }');
}

/** True when this module is the process entry point (not imported by a test). */
function invokedDirectly(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

/** CLI entry. Returns the process exit code; writes the verdict to stdout. */
function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed;
  try {
    parsed = JSON.parse(readRawInput(args.fixturePath));
  } catch (err) {
    const detail = `invalid input - could not read or parse the fixture: ${err.message}`;
    process.stderr.write(`validate-adapter: ${detail}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, failures: [{ invariant: 'INPUT', detail }] }, null, 2)}\n`
    );
    return 2;
  }

  let items;
  try {
    items = extractItems(parsed);
  } catch (err) {
    const detail = `invalid input - ${err.message}`;
    process.stderr.write(`validate-adapter: ${detail}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, failures: [{ invariant: 'INPUT', detail }] }, null, 2)}\n`
    );
    return 2;
  }

  const verdict = validate(items);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) {
    process.stderr.write(
      `validate-adapter: ${verdict.failures.length} invariant(s) failed: ${verdict.failures
        .map((f) => f.invariant)
        .join(', ')}\n`
    );
  }
  return verdict.ok ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main, validate };
