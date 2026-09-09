/**
 * `--claude-only`, the second of the two paths that write a manifest somebody
 * else wrote.
 *
 * Measured the same way `enable-harness.test.ts` measures its own: as a **byte
 * diff**. The manifest is hand-authored, so the bar is not "the result parses to
 * the right thing" — a `JSON.parse` + `JSON.stringify` round-trip clears that
 * bar while reflowing every line of somebody's four-space, one-line-array,
 * particular file. {@link singleInsertion} refuses any change that is not one
 * contiguous insertion, and each case then says exactly what was inserted.
 *
 * The refusals matter as much as the writes: this module reads its own result
 * back before committing to it, and a guard that has stopped guarding is a guard
 * nobody notices. The last case here removes it and requires a red.
 *
 * @module scaffold/__tests__/declare-claude-only
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareClaudeOnlySkill } from '../declare-claude-only.js';
import { HARNESS_MANIFEST_PATH } from '../manifest.js';

let repo = '';

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

/** The entry every case writes unless it says otherwise. */
const ENTRY = {
  name: 'deploy-checklist',
  path: '.claude/skills/deploy-checklist',
  reason: 'Kept in Claude Code on purpose.',
};

/**
 * Stage a repo whose manifest holds exactly `body`.
 *
 * @param body - the manifest text, byte for byte.
 * @returns the absolute path of the manifest.
 */
function stageManifest(body: string): string {
  repo = mkdtempSync(join(tmpdir(), 'harness-declare-repo-'));
  const abs = join(repo, HARNESS_MANIFEST_PATH);
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/**
 * The one contiguous run of characters `after` adds to `before`, or `null` when
 * the change is anything else at all.
 *
 * The same helper `enable-harness.test.ts` uses, and for the same claim: nothing
 * already in the file moved.
 *
 * @param before - the file as it was.
 * @param after - the file as it is.
 * @returns the inserted text, or `null`.
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

describe('declareClaudeOnlySkill — the write', () => {
  it('AP-17: adds the whole key to a manifest that has none, and moves nothing else', () => {
    const abs = stageManifest('{\n  "version": 1,\n  "harnesses": ["claude-code", "codex"]\n}\n');
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    const inserted = [
      ',',
      '  "claudeOnlySkills": [{',
      `    "name": "${ENTRY.name}",`,
      `    "path": "${ENTRY.path}",`,
      `    "reason": "${ENTRY.reason}"`,
      '  }]',
    ].join('\n');
    expect(result).toEqual({ outcome: 'declared', path: HARNESS_MANIFEST_PATH, inserted });
    expect(singleInsertion(before, readFileSync(abs, 'utf8'))).toBe(inserted);
  });

  it('AP-17: appends into a key the file already has, in the file’s own indentation', () => {
    // The `findValueSpan` path rather than the whole-key one, and a four-space
    // file, so the entry is written the way the rest of the file is written.
    const abs = stageManifest(
      '{\n    "version": 1,\n    "harnesses": ["claude-code"],\n    "claudeOnlySkills": [\n        {\n            "name": "old",\n            "path": ".claude/skills/old",\n            "reason": "because"\n        }\n    ]\n}\n'
    );
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    expect(result.outcome).toBe('declared');
    const inserted = singleInsertion(before, readFileSync(abs, 'utf8'));
    expect(inserted).toBe(
      [
        ',',
        '        {',
        `            "name": "${ENTRY.name}",`,
        `            "path": "${ENTRY.path}",`,
        `            "reason": "${ENTRY.reason}"`,
        '        }',
      ].join('\n')
    );
    // And the file still says what it said, plus the one entry.
    expect(JSON.parse(readFileSync(abs, 'utf8')).claudeOnlySkills).toEqual([
      { name: 'old', path: '.claude/skills/old', reason: 'because' },
      ENTRY,
    ]);
  });

  it('AP-17: writes a readable entry into a one-line and an empty array alike', () => {
    // Both layouts a person really writes. The entry is several lines whichever
    // the container is, so it never lands as one 180-character line.
    const single = stageManifest(
      '{\n  "version": 1,\n  "claudeOnlySkills": [{"name": "old", "path": ".claude/skills/old", "reason": "because"}]\n}\n'
    );
    expect(declareClaudeOnlySkill(repo, ENTRY).outcome).toBe('declared');
    expect(JSON.parse(readFileSync(single, 'utf8')).claudeOnlySkills).toHaveLength(2);
    expect(readFileSync(single, 'utf8')).toContain(`"name": "${ENTRY.name}"`);
    rmSync(repo, { recursive: true, force: true });

    const empty = stageManifest('{\n  "version": 1,\n  "claudeOnlySkills": []\n}\n');
    const beforeEmpty = readFileSync(empty, 'utf8');
    expect(declareClaudeOnlySkill(repo, ENTRY).outcome).toBe('declared');
    const inserted = singleInsertion(beforeEmpty, readFileSync(empty, 'utf8'));
    expect(inserted).toBe(
      [
        '',
        '    {',
        `      "name": "${ENTRY.name}",`,
        `      "path": "${ENTRY.path}",`,
        `      "reason": "${ENTRY.reason}"`,
        '    }',
      ].join('\n')
    );
    expect(JSON.parse(readFileSync(empty, 'utf8')).claudeOnlySkills).toEqual([ENTRY]);
  });

  it('AP-17: says already-declared, and writes nothing, when the name is in the list', () => {
    const abs = stageManifest(
      `{\n  "version": 1,\n  "claudeOnlySkills": [{ "name": "${ENTRY.name}", "path": "elsewhere", "reason": "r" }]\n}\n`
    );
    const before = readFileSync(abs, 'utf8');

    expect(declareClaudeOnlySkill(repo, ENTRY)).toEqual({
      outcome: 'already-declared',
      path: HARNESS_MANIFEST_PATH,
    });
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });
});

describe('declareClaudeOnlySkill — the refusals', () => {
  it('AP-17: refuses a manifest that is not JSON, naming what is wrong with it', () => {
    const abs = stageManifest('{\n  // a comment JSON does not have\n  "version": 1\n}\n');
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    expect(result.outcome).toBe('unwritable');
    expect(result.outcome === 'unwritable' && result.reason).toMatch(/^it is not valid JSON \(/);
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('AP-17: refuses a manifest the engine’s own schema rejects, naming the key', () => {
    // The same strict schema `loadManifest` uses. Writing into a file that will
    // not load costs a person a hand-edit they did not ask for, on top of the
    // one they already have.
    const abs = stageManifest('{\n  "version": 1,\n  "sharedSkills": ["release"]\n}\n');
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    expect(result.outcome).toBe('unwritable');
    expect(result.outcome === 'unwritable' && result.reason).toContain('sharedSkills');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('AP-17: refuses a file with no root object to add the key to', () => {
    // Valid JSON, and the schema's own error is what a person reads — the file
    // is an array, so there is no place a key could go even if it parsed.
    const abs = stageManifest('[]\n');
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    expect(result.outcome).toBe('unwritable');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });

  it('AP-17: the read-back guard is what stops a bad edit reaching the file', () => {
    // A manifest with the key written TWICE. It is legal JSON and tools do
    // produce it; every reader takes the last one, and the text surgery finds
    // the first. So the insertion lands in a key nothing reads, and the file
    // would come back with a `--claude-only` that did nothing at all.
    //
    // The guard is the only thing that catches it: this module reads its own
    // result back and compares the WHOLE document to what was asked for, so a
    // layout the surgery got wrong writes nothing instead of something subtly
    // wrong. Delete `isExactlyOneSkillDeclared` and this case goes green over a
    // manifest whose entry is in the dead key.
    const abs = stageManifest(
      '{\n  "version": 1,\n  "claudeOnlySkills": [],\n  "claudeOnlySkills": []\n}\n'
    );
    const before = readFileSync(abs, 'utf8');

    const result = declareClaudeOnlySkill(repo, ENTRY);

    expect(result).toEqual({
      outcome: 'unwritable',
      path: HARNESS_MANIFEST_PATH,
      reason: 'recording the skill would have changed something else in the file',
    });
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });
});
