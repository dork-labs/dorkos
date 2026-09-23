/**
 * Guard for `specs/community-tenancy-contract/05-isolation-receipt.md`: every
 * adversarial-matrix row in the specification and every task 4.2 acceptance
 * criterion must map to at least one live test, named by file and exact title.
 * The requirements are read from the spec itself, so a new or reworded row
 * fails here until the receipt is updated with a real proof.
 *
 * This is the fast pre-filter only. Whether each cited test actually ran and
 * passed is decided from runner reports by `scripts/tenancy-receipt.ts`, which
 * `test:pg` (real PostgreSQL and unit proofs) and `test:browser` run last.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readReceipt,
  readRequirements,
  repoRoot,
  runnerFor,
} from '../../scripts/tenancy-receipt.js';

/**
 * Titles of `it`/`test` declarations in one file, as written in source. Only a
 * pre-filter: a declaration can sit in a skipped block, behind a false condition,
 * or in a comment, so the runner report is what proves a test ran.
 * Skipped, todo, and focused declarations do not count as proof.
 */
function liveTestTitles(file: string): Set<string> {
  const source = readFileSync(resolve(repoRoot, file), 'utf8');
  const titles = new Set<string>();
  const declaration =
    /\b(it|test)((?:\.(?:skip|only|todo|each|concurrent|sequential|fails))*)(?:\(\s*\[[^\]]*\](?:\s+as\s+const)?\s*\))?\s*\(\s*(['"`])/g;
  for (const match of source.matchAll(declaration)) {
    const modifiers = match[2];
    const quote = match[3];
    let title = '';
    let index = match.index + match[0].length;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') index += 1;
      title += source[index];
      index += 1;
    }
    if (/\.(skip|todo|only)/.test(modifiers)) continue;
    titles.add(title);
  }
  return titles;
}

const requirements = readRequirements();
const entries = readReceipt();

/**
 * Proofs that live in the local DorkOS app's own suites, cited in a row's
 * Scope note as `- local app: \`file\` — title`. No receipt runner executes
 * them (they run in the client unit suite and the e2e browser projects), so
 * they are not receipt proofs; this only keeps each citation pointing at a real
 * test, and keeps the receipt from promising a proof that never landed.
 */
function localAppProofs(): { file: string; title: string }[] {
  const receipt = readFileSync(
    resolve(repoRoot, 'specs/community-tenancy-contract/05-isolation-receipt.md'),
    'utf8'
  );
  return receipt
    .split('\n')
    .map((line) => /^- local app: `([^`]+)` — (.+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ file: match[1]!, title: match[2]!.trim() }));
}

describe('tenant isolation receipt', () => {
  it('reads a non-empty matrix and criteria list from the spec', () => {
    // A parser that silently finds nothing would make every other check vacuous.
    expect(requirements.filter((row) => row.startsWith('M:')).length).toBeGreaterThanOrEqual(13);
    expect(requirements.filter((row) => row.startsWith('U:')).length).toBeGreaterThanOrEqual(5);
  });

  it('has exactly one receipt entry for every matrix row and 4.2 criterion, and nothing stale', () => {
    const quoted = entries.map((entry) => `${entry.id[0]}:${entry.requirement}`).sort();
    expect(quoted).toEqual([...requirements].sort());
  });

  it('points every local-app citation at a real test, and promises no proof still to come', () => {
    const cited = localAppProofs();
    expect(cited.length).toBeGreaterThan(0);
    for (const proof of cited) {
      expect(existsSync(resolve(repoRoot, proof.file)), proof.file).toBe(true);
      expect(
        liveTestTitles(proof.file).has(proof.title),
        `no test "${proof.title}" declared in ${proof.file}`
      ).toBe(true);
    }
    const receipt = readFileSync(
      resolve(repoRoot, 'specs/community-tenancy-contract/05-isolation-receipt.md'),
      'utf8'
    );
    expect(receipt).not.toMatch(/will be proven/i);
  });

  it.each(entries.map((entry) => [entry.id, entry] as const))(
    '%s cites at least one test a receipt runner executes, by file and exact title',
    (_id, entry) => {
      expect(entry.proofs.length, `${entry.id} has no proof`).toBeGreaterThan(0);
      for (const proof of entry.proofs) {
        expect(existsSync(resolve(repoRoot, proof.file)), `${entry.id}: ${proof.file}`).toBe(true);
        expect(() => runnerFor(proof.file), `${entry.id}: ${proof.file}`).not.toThrow();
        expect(
          liveTestTitles(proof.file).has(proof.title),
          `${entry.id}: no test "${proof.title}" declared in ${proof.file}`
        ).toBe(true);
      }
    }
  );
});
