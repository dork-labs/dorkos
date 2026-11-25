/**
 * The agent's home on a Claude Code launch, and its menu, kept apart per agent
 * (DOR-5250). Real folders, the real resolver and the real command cache; the
 * registry is played by two registered homes. What the CLI does with the added
 * folder is shown live in `home-skills-folder.binary.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import { CommandRegistryService } from '../command-registry.js';
import { RuntimeCache } from '../../messaging/runtime-cache.js';
import { applyHomeSkillsFolder, commandsKeyFor, commandsWithHome } from '../home-skills-folder.js';

const CLAUDE_MD_VAR = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
let root: string;
let ana: string;
let bo: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-home-folder-')));
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

describe('the home on the launch', () => {
  it('adds the folder once, drops the CLAUDE.md variable, and keeps the settings it had', () => {
    const options = {
      additionalDirectories: [ana],
      env: { PATH: '/bin', [CLAUDE_MD_VAR]: '1' },
      settings: { fastMode: true, env: { ANTHROPIC_BASE_URL: 'http://credits.test' } },
    } as Options;
    applyHomeSkillsFolder(options, ana);
    expect(options.additionalDirectories).toEqual([ana]);
    expect(options.env).toEqual({ PATH: '/bin' });
    expect(options.settings).toEqual({
      fastMode: true,
      env: { ANTHROPIC_BASE_URL: 'http://credits.test', [CLAUDE_MD_VAR]: '' },
    });
  });

  it('changes nothing without a home', () => {
    const options = { env: { [CLAUDE_MD_VAR]: '1' } } as Options;
    applyHomeSkillsFolder(options, undefined);
    expect(options).toEqual({ env: { [CLAUDE_MD_VAR]: '1' } });
  });
});

describe('the Claude Code menu outside the home', () => {
  const sdk = (...names: string[]) =>
    names.map((name) => ({ name, description: name, argumentHint: '' }));

  function addSkill(folder: string, name: string): void {
    const dir = path.join(folder, '.agents', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  it('keys a launch that adds a home apart, so the folder and other agents never see its list', async () => {
    const cache = new RuntimeCache(root);
    const registry = new CommandRegistryService(project);
    const anaKey = commandsKeyFor(project, ana);
    expect(anaKey).not.toBe(project);
    expect(commandsKeyFor(project, bo)).not.toBe(anaKey);
    expect(commandsKeyFor(ana, ana)).toBe(ana);

    // Ana's launch outside her home reported her skill; the folder's own launch did not.
    cache.buildSendCallbacks(project, anaKey).onCommandsReceived?.(sdk('compact', 'ana-skill'));
    cache.buildSendCallbacks(project).onCommandsReceived?.(sdk('compact'));

    const listed = async (agentPath?: string) =>
      (await commandsWithHome(cache, registry, project, agentPath)).commands.map(
        (entry) => entry.fullCommand
      );
    expect(await listed(ana)).toEqual(['/ana-skill', '/compact']);
    expect(await listed(undefined)).toEqual(['/compact']);
    expect(await listed(bo)).toEqual(['/compact']);
  });

  it('lists the home’s skills before any launch has reported them', async () => {
    addSkill(ana, 'ana-skill');
    addSkill(bo, 'bo-skill');
    const cache = new RuntimeCache(root);
    cache.buildSendCallbacks(project).onCommandsReceived?.(sdk('compact'));
    const { commands } = await commandsWithHome(
      cache,
      new CommandRegistryService(project),
      project,
      ana
    );
    expect(commands.map((entry) => entry.fullCommand)).toEqual(['/ana-skill', '/compact']);
  });
});
