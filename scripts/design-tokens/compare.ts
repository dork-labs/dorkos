/**
 * The design-token gate's verdicts: measured counts against the baseline, a
 * baseline against its base, and one line a person can act on.
 *
 * WHY A SEPARATE FILE. `scripts/check-design-tokens.ts` holds the rules, and
 * the rule guard imports a base's copy of it alone, so it imports nothing
 * relative and its size is spent on rules. Its `main` loads this one only when
 * it runs, as it does the rule guard.
 *
 * @module scripts/design-tokens/compare
 */
import { RULES, type Counts, type Finding, type Rule } from '../check-design-tokens.ts';

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What `measure` (check-design-tokens.ts) found.
 * @param baseline - The committed baseline.
 * @param rules - The rules the counts came from.
 */
export function compare(counts: Counts, baseline: Counts, rules: Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  for (const { id: rule, kind } of rules) {
    const now = counts[rule] ?? {};
    if (kind === 'hard') {
      for (const [file, count] of Object.entries(now)) {
        findings.push({ kind: 'hard', rule, file, count });
      }
      continue;
    }
    const held = baseline[rule] ?? {};
    for (const [file, count] of Object.entries(now)) {
      const before = held[file] ?? 0;
      if (count > before) findings.push({ kind: 'grew', rule, file, count, baseline: before });
      else if (count < before)
        findings.push({ kind: 'stale', rule, file, count, baseline: before });
    }
    for (const [file, before] of Object.entries(held)) {
      if (!(file in now)) findings.push({ kind: 'stale', rule, file, count: 0, baseline: before });
    }
  }
  return findings;
}

/**
 * Which rules may seed a first baseline: the ratchets whose id the base never
 * defined. None may, when a rule the base defined is gone from this tree, so a
 * rename cannot reset a count by starting a new rule at its own number.
 *
 * @param rules - The rules on this tree.
 * @param baseIds - The rule ids the base defined, or null when they are unknown.
 */
export function seedableRules(rules: Rule[], baseIds: string[] | null): Set<string> {
  if (!baseIds) return new Set();
  if (baseIds.some((id) => !rules.some((r) => r.id === id))) return new Set();
  return new Set(
    rules.filter((r) => r.kind === 'ratchet' && !baseIds.includes(r.id)).map((r) => r.id)
  );
}

/**
 * Entries the baseline raised against its base.
 *
 * A rule in `seedable` has no base entries to raise, so its first baseline is
 * held to what the check measures here: a number above it is a raise.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 * @param seedable - Rules that may seed a first baseline, from {@link seedableRules}.
 * @param counts - What `measure` (check-design-tokens.ts) found on this tree, to check a seed against.
 */
export function raisedAgainst(
  current: Counts,
  base: Counts,
  seedable: ReadonlySet<string> = new Set(),
  counts: Counts = {}
): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, files] of Object.entries(current)) {
    const seeding = seedable.has(rule) && !(rule in base);
    for (const [file, count] of Object.entries(files)) {
      const before = seeding ? (counts[rule]?.[file] ?? 0) : (base[rule]?.[file] ?? 0);
      if (count > before) findings.push({ kind: 'raised', rule, file, count, baseline: before });
    }
  }
  return findings;
}

/** One line a person can act on. */
export function describe(f: Finding, rules: Rule[] = RULES): string {
  const fix = rules.find((r) => r.id === f.rule)?.fix ?? '';
  switch (f.kind) {
    case 'hard':
      return `${f.file}: ${f.count} of ${f.rule}, which may not exist: ${fix}.`;
    case 'grew':
      return `${f.file}: ${f.rule} rose to ${f.count} (baseline ${f.baseline}): ${fix}.`;
    case 'stale':
      return `${f.file}: ${f.rule} fell to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:design-tokens -- --update\` to lock that in.`;
    case 'raised':
      return `${f.file}: ${f.rule} baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
    case 'rule':
      return `${f.file}: ${f.detail}.`;
  }
}
