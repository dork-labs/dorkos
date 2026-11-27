/**
 * Whose home a session's `/` menu borrows skills from, and how they join the
 * working folder's (DOR-5250). Real folders and the real resolver, with the
 * registry played by two registered homes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Computer-side code reads agent facts through the port, wired as boot does.
import '../../../core/agent-identity/__tests__/wire-test-facts.js';
import type { CommandEntry } from '@dorkos/shared/types';
import { setAgentHomeRegistry } from '../../../core/agent-identity/index.js';
import { homeOutside } from '../home-skills-block.js';
import { withHomeSkillCommands } from '../home-skill-commands.js';

let root: string;
let ana: string;
let bo: string;
let project: string;

function addSkill(folder: string, name: string, extra = ''): void {
  const dir = path.join(folder, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} from ${path.basename(folder)}\n${extra}---\n\nSteps.\n`
  );
}

const names = (commands: CommandEntry[]) => commands.map((entry) => entry.fullCommand);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-home-commands-')));
  [ana, bo, project] = ['agents/ana', 'agents/bo', 'work/site'].map((dir) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    return path.join(root, dir);
  });
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === ana || dir === bo,
    listRegisteredHomes: () => [ana, bo],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
});

afterEach(() => {
  setAgentHomeRegistry(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the home a session outside it borrows from', () => {
  it('is the agent’s registered home, by real path, only when the folder is outside it', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(ana, alias);
    expect(homeOutside(project, ana)).toBe(ana);
    // Named through a link, it is still the registered home, answered by real path.
    expect(homeOutside(project, alias)).toBe(ana);
    expect(homeOutside(ana, ana)).toBeUndefined();
    fs.mkdirSync(path.join(ana, 'notes'));
    expect(homeOutside(path.join(ana, 'notes'), ana)).toBeUndefined();
    expect(homeOutside(undefined, ana)).toBeUndefined();
  });

  it('is never another agent’s, nor a folder no agent is registered at', () => {
    // Standing in Bo's home, a session for Ana resolves to nobody.
    expect(homeOutside(bo, ana)).toBeUndefined();
    expect(homeOutside(project, path.join(root, 'work'))).toBeUndefined();
    expect(homeOutside(project, undefined)).toBeUndefined();
  });
});

describe('the home’s skills in the menu', () => {
  it('adds them outside the home, and the working folder’s name wins a clash', () => {
    addSkill(ana, 'triage');
    addSkill(ana, 'release');
    addSkill(ana, 'quiet', 'user-invocable: false\n');
    const folder: CommandEntry[] = [{ fullCommand: '/release', description: 'release from site' }];

    const merged = withHomeSkillCommands(folder, project, ana);
    expect(names(merged)).toEqual(['/release', '/triage']);
    expect(merged.find((entry) => entry.fullCommand === '/release')?.description).toBe(
      'release from site'
    );
  });

  it('adds nothing inside the home, for another agent’s folder, or with no agent', () => {
    addSkill(ana, 'triage');
    addSkill(bo, 'bo-only');
    expect(withHomeSkillCommands([], ana, ana)).toEqual([]);
    expect(withHomeSkillCommands([], bo, ana)).toEqual([]);
    expect(withHomeSkillCommands([], project, undefined)).toEqual([]);
    expect(names(withHomeSkillCommands([], project, bo))).toEqual(['/bo-only']);
  });
});
