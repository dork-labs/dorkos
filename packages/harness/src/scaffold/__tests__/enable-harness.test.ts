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
import { parseHarnessManifest } from '../../manifest/schema.js';

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
      [
        '{\n  "version": 1,\n  "harnesses": []\n}\n',
        '{\n  "version": 1,\n  "harnesses": ["cursor"]\n}\n',
      ],
      [
        '{\n  "version": 1,\n  "harnesses": [\n  ]\n}\n',
        '{\n  "version": 1,\n  "harnesses": [\n    "cursor"\n  ]\n}\n',
      ],
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
      '  "skillBundles": [{ "name": "a", "sourceRoot": ".agents/bundles/a" }],',
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
    expect(after).toContain(
      '"skillBundles": [{ "name": "a", "sourceRoot": ".agents/bundles/a" }],'
    );
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('inserts byte-pure into a manifest still carrying all four retired keys', () => {
    // The four keys DOR-1858 retired are ACCEPTED and ignored, which is exactly
    // what this path needs: `--enable` validates with the strict schema before it
    // writes, so a schema that rejected them would refuse to edit every manifest
    // written before the retirement. Their contents are deliberately messy — one
    // shape the old schema would have rejected outright.
    const body = [
      '{',
      '  "version": 1,',
      '  "harnesses": ["claude-code"],',
      '  "skillWrappers": [{ "target": "codex", "name": "x", "anything": true }],',
      '  "commandMappings": "not even an array",',
      '  "instructionProjections": null,',
      '  "skillBundles": [{ "name": "flow", "skills": [{ "name": "a" }] }],',
      '  "hookPolicies": []',
      '}',
      '',
    ].join('\n');
    const abs = stageManifest(body);

    expect(enableHarnessInManifest(repo, 'cursor').outcome).toBe('enabled');

    const after = readFileSync(abs, 'utf8');
    expect(singleInsertion(body, after)).toBe(', "cursor"');
    expect(after).toContain('"commandMappings": "not even an array",');
    expect(after).toContain('"instructionProjections": null,');
    expect(parseHarnessManifest(JSON.parse(after)).harnesses).toEqual(['claude-code', 'cursor']);
  });

  it('treats the schema default as enabled, since that is what the engine loads', () => {
    // No `harnesses` key means `["claude-code"]` to every reader of this file,
    // so saying "not enabled" about Claude Code here would be a claim about the
    // text rather than about what runs.
    const abs = stageManifest('{\n  "version": 1\n}\n');
    const before = readFileSync(abs, 'utf8');

    expect(enableHarnessInManifest(repo, 'claude-code').outcome).toBe('already-enabled');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('says so and writes nothing when the harness is already enabled', () => {
    const abs = stageManifest('{\n  "version": 1,\n  "harnesses": ["cursor"]\n}\n');
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

  it('adds the whole key when the manifest has none, keeping the defaulted set', () => {
    // `{"version": 1}` is a VALID manifest: the schema defaults `harnesses` to
    // `["claude-code"]`. So the notice prints for it, and `--enable` refusing
    // would be the tool pointing at a command it had just declined to run.
    // Writing `["cursor"]` would be worse than refusing — it would turn Claude
    // Code off on the way past.
    const body = '{\n  "version": 1\n}\n';
    const abs = stageManifest(body);

    const result = enableHarnessInManifest(repo, 'cursor');

    expect(result.outcome).toBe('enabled');
    const after = readFileSync(abs, 'utf8');
    expect(after).toBe('{\n  "version": 1,\n  "harnesses": ["claude-code", "cursor"]\n}\n');
    expect(singleInsertion(body, after)).toBe(',\n  "harnesses": ["claude-code", "cursor"]');
    // And the file the engine now loads says what the run just did.
    expect(parseHarnessManifest(JSON.parse(after)).harnesses).toEqual(['claude-code', 'cursor']);
  });

  it('refuses a manifest the engine would then reject, and writes nothing', () => {
    // `sharedSkills` is the stale key the strict schema exists to catch
    // (`manifest/schema.ts`). Checking only `Array.isArray(harnesses)` let this
    // file be MODIFIED and then fail to load: the run exited 1 having edited a
    // manifest nobody asked it to touch.
    const body = '{\n  "harnesses": ["codex"],\n  "sharedSkills": ["a"]\n}\n';
    const abs = stageManifest(body);

    const result = enableHarnessInManifest(repo, 'cursor');

    expect(result.outcome).toBe('unwritable');
    expect(result.outcome === 'unwritable' && result.reason).toContain(
      'not a valid harness manifest'
    );
    expect(readFileSync(abs, 'utf8')).toBe(body);
  });

  it('edits the root list, not the same spelling inside somebody\u2019s note', () => {
    // The strict schema forbids a nested `harnesses` KEY, but nothing stops a
    // person writing the spelling in a string — and a regex-based finder would
    // edit that. The scanner walks strings and depth, so it reaches neither.
    const body = `{
  "version": 1,
  "instructionProjections": [
    {
      "source": "AGENTS.md",
      "status": "planned",
      "targets": [],
      "notes": "the \\"harnesses\\": [\\"codex\\"] spelling, inside a string"
    }
  ],
  "harnesses": ["claude-code"]
}
`;
    const abs = stageManifest(body);

    const result = enableHarnessInManifest(repo, 'codex');

    expect(result.outcome).toBe('enabled');
    const after = readFileSync(abs, 'utf8');
    expect(singleInsertion(body, after)).toBe(', "codex"');
    expect(after).toContain(
      '"notes": "the \\"harnesses\\": [\\"codex\\"] spelling, inside a string"'
    );
    expect(parseHarnessManifest(JSON.parse(after)).harnesses).toEqual(['claude-code', 'codex']);
  });
});
