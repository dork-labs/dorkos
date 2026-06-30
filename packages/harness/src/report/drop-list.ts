/**
 * Drop-list formatter — the honesty surface of a projection plan.
 *
 * Every artifact with no home in a target harness appears here, grouped by
 * harness with its reason, so the operator sees exactly what did not travel and
 * why. Nothing is hidden behind false simplicity.
 *
 * @module report/drop-list
 */
import type { ProjectionAction, ProjectionPlan } from '../plan/types.js';

/**
 * Render `plan.drops` as a readable, honest block grouped by harness.
 *
 * @param plan - the projection plan whose drops to format.
 * @returns a multi-line report, or a clean-state message when there are no drops.
 */
export function formatDropList(plan: ProjectionPlan): string {
  if (plan.drops.length === 0) {
    return 'No drops — every enabled harness can accept every projected artifact.';
  }

  const byHarness = new Map<string, ProjectionAction[]>();
  for (const drop of plan.drops) {
    const list = byHarness.get(drop.harness) ?? [];
    list.push(drop);
    byHarness.set(drop.harness, list);
  }

  const lines: string[] = ['Dropped artifacts (no home in the target harness):'];
  for (const [harness, drops] of [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `${harness}:`);
    for (const drop of drops) {
      lines.push(`  - ${drop.artifact} "${drop.name}": ${drop.reason ?? 'no reason given'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render `plan.warnings` as a readable block grouped by harness — projections
 * that DID land but may not work in the target harness (e.g. a hook command that
 * carries a Claude-only substitution token Codex cannot resolve). Returns an
 * empty string when there are no warnings, so callers can omit the block cleanly.
 *
 * @param plan - the projection plan whose warnings to format.
 * @returns a multi-line warning report, or `''` when there are no warnings.
 */
export function formatWarnings(plan: ProjectionPlan): string {
  if (plan.warnings.length === 0) return '';

  const byHarness = new Map<string, ProjectionPlan['warnings']>();
  for (const warning of plan.warnings) {
    const list = byHarness.get(warning.harness) ?? [];
    list.push(warning);
    byHarness.set(warning.harness, list);
  }

  const lines: string[] = ['Warnings (projected, but may not work in the target harness):'];
  for (const [harness, warnings] of [...byHarness.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push('', `${harness}:`);
    for (const warning of warnings) {
      lines.push(`  - ${warning.artifact} "${warning.name}": ${warning.reason}`);
    }
  }
  return lines.join('\n');
}
