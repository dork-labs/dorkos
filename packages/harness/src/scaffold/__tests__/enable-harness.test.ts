/**
 * `--enable <harness>`, the one path that writes a manifest somebody else wrote
 * (contract TR-11).
 *
 * Every case here is measured the same way: as a **byte diff**. The manifest is
 * a hand-authored file, so the bar is not "the result parses to the right
 * thing" — a `JSON.parse` + `JSON.stringify` round-trip would clear that bar
 * while silently reflowing every line of somebody's four-space, one-line-array,
 * comment-free-but-particular file. {@link singleInsertion} refuses any change
 * that is not one contiguous insertion, and each test then says exactly what
 * that insertion was.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableHarnessInManifest } from '../enable-harness.js';
import { HARNESS_MANIFEST_PATH } from '../manifest.js';

let repo = '';

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

/** Stage a repo whose manifest holds exactly `body`, and return its absolute path. */
function stageManifest(body: string): string {
  repo = mkdtempSync(join(tmpdir(), 'harness-enable-repo-'));
  const abs = join(repo, HARNESS_MANIFEST_PATH);
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/**
 * The one contiguous run of characters `after` adds to `before`, or `null` when
 * the change is anything else at all (a removal, a move, two edits).
 *
 * Computed from the common prefix and the common suffix, so it makes no
 * assumption about WHERE the insertion landed — which is the point: the claim
 * under test is that nothing else in the file moved.
 */
function singleInsertion(before: string, after: string): string | null {
  if (after.length <= before.length) return null;
  let head = 0;
  while (head < before.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const inserted = after.slice(head, after.length - tail);
  return before === after.slice(0, head) + after.slice(after.length - tail) ? inserted : null;
}

describe('enableHarnessInManifest', () => {
  it('adds one element to a two-space manifest and moves nothing else', () => {
    const abs = stageManifest(
      '{\n  "version": 1,\n  "harnesses": [\n    "claude-code",\n    "codex"\n  ],\n  "claudeOnlySkills": []\n}\n'
    );
    const before = readFileSync(abs, 'utf8');

    const result = enableHarnessInManifest(repo, 'cursor');

    expect(result).toEqual({
      outcome: 'enabled',
      harness: 'cursor',
      path: HARNESS_MANIFEST_PATH,
      inserted: ',\n    "cursor"',
    });
    expect(singleInsertion(before, readFileSync(abs, 'utf8'))).toBe(',\n    "cursor"');
  });

  it('follows a four-space file, a tab file, and a single-line array', () => {
    for (const [body, inserted] of [
      [
        '{\n    "version": 1,\n    "harnesses": [\n        "codex"\n    ]\n}\n',
        ',\n        "cursor"',
      ],
      ['{\n\t"version": 1,\n\t"harnesses": [\n\t\t"codex"\n\t]\n}\n', ',\n\t\t"cursor"'],
      ['{ "version": 1, "harnesses": ["codex"] }\n', ', "cursor"'],
      ['{\n  "harnesses": ["claude-code", "codex"],\n  "version": 1\n}\n', ', "cursor"'],
    ] as const) {
      const abs = stageManifest(body);
      const result = enableHarnessInManifest(repo, 'cursor');
      expect(result.outcome).toBe('enabled');
      expect(singleInsertion(body, readFileSync(abs, 'utf8'))).toBe(inserted);
      rmSync(repo, { recursive: true, force: true });
      repo = '';
    }
  });

  it('fills an empty array without disturbing its layout', () => {
    // Asserted as whole bodies rather than as an insertion string: an element
    // added to an empty array shares characters with the whitespace around it,
    // so where the "insertion" starts is ambiguous even though the edit is not.
    // `singleInsertion` still has to answer — that is the pure-insertion claim.
    for (const [body, expected] of [
      ['{\n  "harnesses": []\n}\n', '{\n  "harnesses": ["cursor"]\n}\n'],
      ['{\n  "harnesses": [\n  ]\n}\n', '{\n  "harnesses": [\n    "cursor"\n  ]\n}\n'],
    ] as const) {
      const abs = stageManifest(body);
      expect(enableHarnessInManifest(repo, 'cursor').outcome).toBe('enabled');
      const after = readFileSync(abs, 'utf8');
      expect(after).toBe(expected);
      expect(singleInsertion(body, after)).not.toBeNull();
      rmSync(repo, { recursive: true, force: true });
      repo = '';
    }
  });

  it('keeps every other key, its order, and the trailing newline', () => {
    // Deliberately not the shape the scaffolder writes: keys out of order, an
    // array of objects after the one being edited, no trailing comma anywhere.
    const body = [
      '{',
      '  "skillBundles": [{ "name": "a", "skills": ["x"] }],',
      '  "harnesses": ["claude-code"],',
      '  "version": 1,',
      '  "hookPolicies": []',
      '}',
      '',
    ].join('\n');
    const abs = stageManifest(body);

    enableHarnessInManifest(repo, 'gemini');

    const after = readFileSync(abs, 'utf8');
    expect(singleInsertion(body, after)).toBe(', "gemini"');
    expect(after).toContain('"skillBundles": [{ "name": "a", "skills": ["x"] }],');
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('says so and writes nothing when the harness is already enabled', () => {
    const abs = stageManifest('{\n  "harnesses": ["cursor"]\n}\n');
    const before = readFileSync(abs, 'utf8');

    expect(enableHarnessInManifest(repo, 'cursor')).toEqual({
      outcome: 'already-enabled',
      harness: 'cursor',
      path: HARNESS_MANIFEST_PATH,
    });
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('refuses a file it cannot read as JSON, and leaves it exactly as it was', () => {
    const abs = stageManifest('{\n  "harnesses": ["codex",\n}\n');
    const before = readFileSync(abs, 'utf8');

    const result = enableHarnessInManifest(repo, 'cursor');

    expect(result.outcome).toBe('unwritable');
    expect(result.outcome === 'unwritable' && result.reason).toContain('not valid JSON');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('refuses a manifest with no harnesses list', () => {
    const abs = stageManifest('{\n  "version": 1\n}\n');
    const before = readFileSync(abs, 'utf8');

    const result = enableHarnessInManifest(repo, 'cursor');

    expect(result.outcome).toBe('unwritable');
    expect(result.outcome === 'unwritable' && result.reason).toContain('"harnesses"');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('edits the root list, not a same-named key nested inside another value', () => {
    // Nothing in the schema nests a `harnesses` key today. The scanner is
    // depth-aware anyway, because the day something does, a first-match search
    // would quietly edit the wrong list.
    const body =
      '{\n  "instructionProjections": [{ "path": "x", "harnesses": ["codex"] }],\n  "harnesses": ["claude-code"]\n}\n';
    const abs = stageManifest(body);

    enableHarnessInManifest(repo, 'codex');

    const after = readFileSync(abs, 'utf8');
    expect(after).toContain('{ "path": "x", "harnesses": ["codex"] }');
    expect(JSON.parse(after)).toMatchObject({ harnesses: ['claude-code', 'codex'] });
  });
});
