/**
 * The refusal an agent reads when its config patch names an operator-only
 * setting. Split out of `config-write-policy.ts`, which holds the policy table,
 * so that file stays inside its line budget.
 *
 * @module services/core/operator/operator-only-refusal
 */
import { OPERATOR_ONLY_STAKES } from './config-write-policy.js';

/**
 * The clause for a refused path with no stake on file. Deliberately says only
 * what is certainly true, so an unclassified path can never be described as
 * something it is not. The drift guard keeps this out of normal use.
 */
const OPERATOR_ONLY_FALLBACK_DESCRIPTION = 'Settings the person keeps for themselves';

/**
 * The refusal an agent reads. Names exactly what it may not change, says why in
 * one plain sentence, and tells it what to do instead, because this text lands in
 * a model's context and a model that is only told "no" will try again.
 *
 * The "why" is per stake, not one blanket claim: the paths are grouped by
 * {@link OPERATOR_ONLY_STAKES} and each group gets the sentence that is true of
 * it. A refusal that overstates what a setting does is a lie the model then
 * carries into the rest of the conversation (DOR-1044).
 *
 * @param paths - The offending policy paths, from {@link findOperatorOnlyPaths}.
 * @returns One paragraph written for the model.
 */
export function describeOperatorOnlyRefusal(paths: readonly string[]): string {
  const remaining = new Set(paths);
  const clauses: string[] = [];

  for (const group of OPERATOR_ONLY_STAKES) {
    const matched = paths.filter((path) => group.paths.includes(path));
    if (matched.length === 0) continue;
    for (const path of matched) remaining.delete(path);
    clauses.push(`${group.description}: ${matched.join(', ')}.`);
  }

  if (remaining.size > 0) {
    clauses.push(`${OPERATOR_ONLY_FALLBACK_DESCRIPTION}: ${[...remaining].join(', ')}.`);
  }

  return [
    'DorkOS changed nothing.',
    "These settings are the person's to choose, not yours.",
    ...clauses,
    'Ask the person to change them in DorkOS Settings.',
    'If your patch also had ordinary settings in it, send those again on their own and they will go through.',
  ].join(' ');
}
