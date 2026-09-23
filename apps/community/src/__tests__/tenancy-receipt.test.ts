/**
 * Guard for `specs/community-tenancy-contract/05-isolation-receipt.md`: every
 * adversarial-matrix row in the specification and every task 4.2 acceptance
 * criterion must map to at least one live test, named by file and exact title.
 * The requirements are read from the spec itself, so a new or reworded row
 * fails here until the receipt is updated with a real proof.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const specDir = resolve(repoRoot, 'specs/community-tenancy-contract');

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The bullets of the spec's "Adversarial verification matrix" section. */
function matrixRows(): string[] {
  const spec = readFileSync(resolve(specDir, '02-specification.md'), 'utf8');
  const section = /^## Adversarial verification matrix\n([\s\S]*?)(?=^## )/m.exec(spec);
  if (!section) throw new Error('The specification has no adversarial verification matrix');
  const bullets = section[1].split('\n').filter((line) => line.startsWith('- '));
  return bullets.map((line) => normalize(line.slice(2)));
}

/** The acceptance criteria of task 4.2 in the canonical task graph. */
function upgradeCriteria(): string[] {
  const tasks = JSON.parse(readFileSync(resolve(specDir, '03-tasks.json'), 'utf8')) as {
    tasks: { id: string; description: string }[];
  };
  const task = tasks.tasks.find((candidate) => candidate.id === '4.2');
  if (!task) throw new Error('Task 4.2 is missing from 03-tasks.json');
  const [, criteria] = task.description.split('Acceptance criteria:');
  return criteria
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => normalize(line.slice(2)));
}

interface ReceiptEntry {
  id: string;
  requirement: string;
  proofs: { file: string; title: string }[];
}

function receiptEntries(): ReceiptEntry[] {
  const receipt = readFileSync(resolve(specDir, '05-isolation-receipt.md'), 'utf8');
  const entries: ReceiptEntry[] = [];
  let current: ReceiptEntry | undefined;
  for (const line of receipt.split('\n')) {
    const heading = /^### ([MU]\d+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], requirement: '', proofs: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('> ')) current.requirement = normalize(line.slice(2));
    const proof = /^- `([^`]+)` — (.+)$/.exec(line);
    if (proof) current.proofs.push({ file: proof[1], title: proof[2].trim() });
  }
  return entries;
}

/**
 * Titles of live `it`/`test` declarations in one file, as written in source.
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

const requirements = [
  ...matrixRows().map((text) => ({ kind: 'M', text })),
  ...upgradeCriteria().map((text) => ({ kind: 'U', text })),
];
const entries = receiptEntries();

describe('tenant isolation receipt', () => {
  it('reads a non-empty matrix and criteria list from the spec', () => {
    // A parser that silently finds nothing would make every other check vacuous.
    expect(matrixRows().length).toBeGreaterThanOrEqual(13);
    expect(upgradeCriteria().length).toBeGreaterThanOrEqual(5);
  });

  it('has exactly one receipt entry for every matrix row and 4.2 criterion, and nothing stale', () => {
    const quoted = entries.map((entry) => `${entry.id[0]}:${entry.requirement}`).sort();
    const required = requirements.map((row) => `${row.kind}:${row.text}`).sort();
    expect(quoted).toEqual(required);
  });

  it.each(entries.map((entry) => [entry.id, entry] as const))(
    '%s names at least one live test by file and exact title',
    (_id, entry) => {
      expect(entry.proofs.length, `${entry.id} has no proof`).toBeGreaterThan(0);
      for (const proof of entry.proofs) {
        expect(existsSync(resolve(repoRoot, proof.file)), `${entry.id}: ${proof.file}`).toBe(true);
        expect(proof.file, `${entry.id}: not a test file`).toMatch(/\.(test|spec)\.tsx?$/);
        expect(
          liveTestTitles(proof.file).has(proof.title),
          `${entry.id}: no live test "${proof.title}" in ${proof.file}`
        ).toBe(true);
      }
    }
  );
});
