import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSkippedSkillLines } from '../messaging/skipped-skills.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function skillAt(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
}

/** A project with a harness manifest, the person's own skill `c`, and a package `acme` shipping a skill named `c`. */
function project(packageSkillName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'oc-skipped-skills-'));
  roots.push(root);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['opencode'] })
  );
  skillAt(join(root, '.agents', 'skills', 'c'), 'c');
  const pkg = join(root, '.dork', 'plugins', 'acme');
  mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme' }));
  skillAt(join(pkg, 'skills', 'c'), packageSkillName);
  return root;
}

describe("the OpenCode agent's note about skipped package skills (DOR-4387)", () => {
  it("names the package skill left out and the person's own skill that kept its place", () => {
    expect(renderSkippedSkillLines(project('c'))).toBe(
      [
        'Some installed package skills were not added, because a skill with the same name already exists and OpenCode keeps only one per name:',
        `- "c" from the acme package: the person's own skill at .agents/skills/c has this name, so theirs is the one you have.`,
      ].join('\n')
    );
  });

  it('says nothing when no package skill was left out', () => {
    expect(renderSkippedSkillLines(project('acme-c'))).toBeUndefined();
  });

  it('says nothing, and does not throw, for a folder that is not a DorkOS project', () => {
    const empty = mkdtempSync(join(tmpdir(), 'oc-skipped-empty-'));
    roots.push(empty);
    expect(renderSkippedSkillLines(empty)).toBeUndefined();
  });
});
