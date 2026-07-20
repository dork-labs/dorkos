/**
 * The eval suite registry: the set of eval cases and a selector that resolves a
 * `--suite <name>` argument to the cases to run. Phase 1 ships only the harness
 * self-test; Phases 2–4 register the structural, judgment, and connector cases
 * into this same registry (`ui`, `marketplace`, `coordination`, `agents`,
 * `safety`, `connectors`).
 *
 * @module evals/suite
 */
import type { EvalCase, EvalTag } from '../types.js';
import { selfTestCase } from './selftest.js';
import { widgetRoundTripCase } from './ui.js';
import { designYourOwnInterviewCase } from './agents.js';

/** Every registered eval case, across all suites. */
export const ALL_CASES: EvalCase[] = [
  selfTestCase,
  widgetRoundTripCase,
  designYourOwnInterviewCase,
];

/** The tag values a `--suite` name may select. */
const TAGS: readonly EvalTag[] = ['smoke', 'core', 'connector', 'experimental'];

/**
 * Resolve a `--suite` name to the cases to run. A name matching a tag
 * (`smoke`/`core`/`connector`/`experimental`) selects every case carrying it;
 * `all` selects every case; otherwise the name is matched against a case id.
 *
 * @param name - The suite selector.
 * @returns The matching cases (possibly empty).
 */
export function selectSuite(name: string): EvalCase[] {
  if (name === 'all') return ALL_CASES;
  if ((TAGS as readonly string[]).includes(name)) {
    return ALL_CASES.filter((c) => c.tags.includes(name as EvalTag));
  }
  return ALL_CASES.filter((c) => c.id === name);
}

export { selfTestCase } from './selftest.js';
export { widgetRoundTripCase } from './ui.js';
export { designYourOwnInterviewCase } from './agents.js';
