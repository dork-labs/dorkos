/**
 * Settings → Extensions says which declared skill is left out and why
 * (DOR-2685). These pin that the card's verdict follows the harness's own
 * rules over a real folder, and that its sentence never carries a path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkDeclaredSkills, SKILL_DROP_REASON } from '../skill-checks.js';

let extensionDir: string;

/** Write `skills/<name>/SKILL.md` with the given body. */
function writeSkill(name: string, body: string): void {
  const dir = path.join(extensionDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

const VALID = (name: string) =>
  `---\nname: ${name}\ndescription: Use when the person asks for ${name}.\n---\n\nDo the thing.\n`;

beforeEach(() => {
  extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-skill-checks-'));
});

afterEach(() => {
  fs.rmSync(extensionDir, { recursive: true, force: true });
});

describe('checkDeclaredSkills', () => {
  it('reports nothing for a manifest that declares no skills', () => {
    expect(checkDeclaredSkills(extensionDir, {})).toBeUndefined();
    expect(checkDeclaredSkills(extensionDir, { skills: [] })).toBeUndefined();
  });

  it('marks a well-formed skill ok, in manifest order beside the dropped ones', () => {
    writeSkill('tidy-notes', VALID('tidy-notes'));
    fs.mkdirSync(path.join(extensionDir, 'skills', 'no-file'), { recursive: true });
    writeSkill('broken', 'no frontmatter at all');

    expect(
      checkDeclaredSkills(extensionDir, { skills: ['tidy-notes', 'gone', 'no-file', 'broken'] })
    ).toEqual([
      { name: 'tidy-notes', status: 'ok' },
      { name: 'gone', status: 'dropped', reason: SKILL_DROP_REASON['missing-folder'] },
      { name: 'no-file', status: 'dropped', reason: SKILL_DROP_REASON['missing-file'] },
      { name: 'broken', status: 'dropped', reason: SKILL_DROP_REASON['invalid-file'] },
    ]);
  });

  it('drops a skill whose folder is a link, as a projection would', () => {
    writeSkill('real', VALID('real'));
    fs.symlinkSync(
      path.join(extensionDir, 'skills', 'real'),
      path.join(extensionDir, 'skills', 'linked')
    );

    expect(checkDeclaredSkills(extensionDir, { skills: ['linked'] })).toEqual([
      { name: 'linked', status: 'dropped', reason: SKILL_DROP_REASON['not-a-folder'] },
    ]);
  });

  it('never puts a path in the sentence a person reads', () => {
    const reasons = Object.values(SKILL_DROP_REASON);
    for (const reason of reasons) expect(reason).not.toContain(extensionDir);
    const [checked] = checkDeclaredSkills(extensionDir, { skills: ['gone'] }) ?? [];
    expect(checked?.reason).not.toContain(path.sep + 'skills' + path.sep);
  });
});
