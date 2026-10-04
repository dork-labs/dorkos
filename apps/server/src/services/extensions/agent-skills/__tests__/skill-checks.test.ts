/**
 * Settings → Extensions says which declared skill is left out and why
 * (DOR-2685). These pin that the card's verdict follows the harness's own
 * rules over a real folder, and that its sentence never carries a path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkExtensionSkillFolder } from '@dorkos/harness';
import { checkDeclaredSkills, SKILL_DROP_REASON, toSkillStatus } from '../skill-checks.js';

let root: string;
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
  // Where every copy of an extension lives: `…/extensions/<id>`.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-skill-checks-'));
  extensionDir = path.join(root, 'extensions', 'mail-app');
  fs.mkdirSync(extensionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkDeclaredSkills', () => {
  it('reports nothing for a manifest that declares no skills', () => {
    expect(checkDeclaredSkills(extensionDir, { id: 'mail-app' })).toBeUndefined();
    expect(checkDeclaredSkills(extensionDir, { id: 'mail-app', skills: [] })).toBeUndefined();
  });

  it('marks a well-formed skill ok, in manifest order beside the dropped ones', () => {
    writeSkill('tidy-notes', VALID('tidy-notes'));
    fs.mkdirSync(path.join(extensionDir, 'skills', 'no-file'), { recursive: true });
    writeSkill('broken', 'no frontmatter at all');

    expect(
      checkDeclaredSkills(extensionDir, {
        id: 'mail-app',
        skills: ['tidy-notes', 'gone', 'no-file', 'broken'],
      })
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

    expect(checkDeclaredSkills(extensionDir, { id: 'mail-app', skills: ['linked'] })).toEqual([
      { name: 'linked', status: 'dropped', reason: SKILL_DROP_REASON['not-a-folder'] },
    ]);
  });

  it('drops every skill when skills/ links out of the extension, as a projection does', () => {
    // An author points skills/ at a shared folder. Projection never links
    // through it, so Settings must not count these skills either.
    const shared = path.join(root, 'shared-skills');
    fs.mkdirSync(path.join(shared, 'tidy-notes'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'tidy-notes', 'SKILL.md'), VALID('tidy-notes'));
    fs.symlinkSync(shared, path.join(extensionDir, 'skills'));

    expect(checkDeclaredSkills(extensionDir, { id: 'mail-app', skills: ['tidy-notes'] })).toEqual([
      { name: 'tidy-notes', status: 'dropped', reason: SKILL_DROP_REASON['not-a-folder'] },
    ]);
  });

  it('drops every skill when the folder is not named after the extension id', () => {
    writeSkill('tidy-notes', VALID('tidy-notes'));

    expect(checkDeclaredSkills(extensionDir, { id: 'other-id', skills: ['tidy-notes'] })).toEqual([
      { name: 'tidy-notes', status: 'dropped', reason: SKILL_DROP_REASON['not-a-folder'] },
    ]);
  });

  it('never puts the harness path-bearing reason in the sentence a person reads', () => {
    // The harness reason names the absolute folder; the card must not.
    const checked = checkExtensionSkillFolder(path.join(extensionDir, 'skills'), 'gone', {
      id: 'mail-app',
    });
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.reason).toContain(root);

    const status = toSkillStatus('gone', checked);
    expect(status.status).toBe('dropped');
    expect(status.reason).toBeDefined();
    expect(status.reason).not.toContain(root);
    expect(status.reason).not.toContain(path.sep + 'extensions' + path.sep);
  });
});
