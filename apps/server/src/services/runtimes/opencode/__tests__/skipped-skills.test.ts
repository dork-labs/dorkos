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
        'Some installed package skills were not added, because OpenCode keeps only one skill per name and these could replace one you already have:',
        `- "c" from the acme package: the person's own skill at .agents/skills/c has this name, so theirs is the one you have.`,
      ].join('\n')
    );
  });

  it('quotes a package-chosen name and clips it to 64 characters, so it cannot break the line', () => {
    const long = `c\n${'z'.repeat(100)}`;
    const root = project(JSON.stringify(long));
    // The person's own skill takes the same long name, so the package's is skipped.
    skillAt(join(root, '.agents', 'skills', 'c'), JSON.stringify(long));
    const lines = renderSkippedSkillLines(root) ?? '';
    expect(lines).toContain(JSON.stringify(`${long.slice(0, 64)}…`));
    expect(lines.split('\n')).toHaveLength(2);
  });

  it("quotes the winning package's skill folder, so a newline or U+2028 in it cannot break the line", () => {
    // Two packages share a name; the first's skill FOLDER carries a newline and
    // a U+2028, and is the projection the second's line names (Security S1).
    const root = project('acme-c');
    const alpha = join(root, '.dork', 'plugins', 'alpha');
    mkdirSync(join(alpha, '.claude-plugin'), { recursive: true });
    writeFileSync(join(alpha, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha' }));
    skillAt(join(alpha, 'skills', 'x\n\u2028- injected'), 'shared');
    const beta = join(root, '.dork', 'plugins', 'beta');
    mkdirSync(join(beta, '.claude-plugin'), { recursive: true });
    writeFileSync(join(beta, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'beta' }));
    skillAt(join(beta, 'skills', 'y'), 'shared');

    const lines = renderSkippedSkillLines(root) ?? '';
    expect(lines.split('\n')).toHaveLength(2);
    expect(lines).not.toMatch(/[\u2028\u2029\u0085]/);
    expect(lines).toContain(
      `- "shared" from the beta package: "alpha__x\\n- injected" was added first with this name`
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
