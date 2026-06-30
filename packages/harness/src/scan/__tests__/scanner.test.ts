import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills } from '../scanner.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('scanSkills', () => {
  it('derives one entry per immediate skill dir containing SKILL.md', () => {
    // Skills a + b have SKILL.md; dir c and a stray file must be ignored.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    for (const name of ['a', 'b']) {
      mkdirSync(join(dir, '.agents', 'skills', name), { recursive: true });
      writeFileSync(join(dir, '.agents', 'skills', name, 'SKILL.md'), '# skill\n');
    }
    mkdirSync(join(dir, '.agents', 'skills', 'c'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'stray.txt'), 'x');

    expect(scanSkills(dir)).toEqual([
      { name: 'a', sourceDir: '.agents/skills/a' },
      { name: 'b', sourceDir: '.agents/skills/b' },
    ]);
  });

  it('returns an empty array when .agents/skills is absent', () => {
    // A repo with no skills root yields no skills and does not throw.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    expect(scanSkills(dir)).toEqual([]);
  });

  it('skips `<pkg>__<skill>` entries — those are managed installed projections, not authored', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    mkdirSync(join(dir, '.agents', 'skills', 'authored'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'authored', 'SKILL.md'), '# a\n');
    mkdirSync(join(dir, '.agents', 'skills', 'acme__projected'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'acme__projected', 'SKILL.md'), '# p\n');

    expect(scanSkills(dir)).toEqual([{ name: 'authored', sourceDir: '.agents/skills/authored' }]);
  });
});
