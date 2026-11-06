import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLocalTools } from '@dorkos/doe';
import { assembleDoeResources } from '../resources.js';

const made: string[] = [];
afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('does not load a skill whose file is an alias of a secret', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'doe-protected-skill-'));
  made.push(cwd);
  const folder = path.join(cwd, '.agents', 'skills', 'probe');
  mkdirSync(folder, { recursive: true });
  const secret = path.join(cwd, 'fixture.key');
  writeFileSync(
    secret,
    '---\nname: probe\ndescription: A harmless probe\n---\nMADE-UP-PRIVATE-CANARY'
  );
  symlinkSync(secret, path.join(folder, 'SKILL.md'));
  const { resources } = await assembleDoeResources({
    cwd,
    userSkillsDir: path.join(cwd, 'user-skills'),
    dorkHome: path.join(cwd, 'data'),
    protectedRoots: {
      cwd,
      data: path.join(cwd, 'data'),
      home: path.join(cwd, 'home'),
      accounts: [],
      agentFolders: [cwd],
      agentHomes: [],
    },
  });
  await expect(resources.skills()).rejects.toThrow('protected');
  await expect(resources.loadSkill('probe', new AbortController().signal)).rejects.toThrow(
    'protected'
  );
});

it('the builder search cannot send a secret file through Resources even without a parent approval', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'doe-protected-'));
  made.push(cwd);
  const folder = path.join(cwd, 'keys');
  mkdirSync(folder);
  const secret = path.join(folder, 'fixture.key');
  const canary = 'MADE-UP-PRIVATE-CANARY';
  writeFileSync(secret, canary);
  const { resources, pathPolicy } = await assembleDoeResources({
    cwd,
    userSkillsDir: path.join(cwd, 'user-skills'),
    dorkHome: path.join(cwd, 'data'),
    protectedRoots: {
      cwd,
      data: path.join(cwd, 'data'),
      home: path.join(cwd, 'home'),
      accounts: [],
      agentFolders: [cwd],
      agentHomes: [],
    },
  });
  const search = createLocalTools({
    workingDirectory: cwd,
    resources,
    pathPolicy,
    builder: true,
  }).find((tool) => tool.name === 'search')!;
  const result = await search.execute(
    { path: folder, query: 'CANARY' },
    {
      sessionId: 'probe',
      workingDirectory: cwd,
      scope: 'child:probe',
      signal: new AbortController().signal,
      emit: () => {},
    }
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(canary);
});

it('does not load a protected alias as initial or nested instructions', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'doe-protected-instructions-'));
  made.push(cwd);
  const nested = path.join(cwd, 'nested');
  mkdirSync(nested);
  const secret = path.join(cwd, 'fixture.key');
  writeFileSync(secret, 'MADE-UP-PRIVATE-CANARY');
  const options = {
    cwd,
    userSkillsDir: path.join(cwd, 'user-skills'),
    dorkHome: path.join(cwd, 'data'),
    protectedRoots: {
      cwd,
      data: path.join(cwd, 'data'),
      home: path.join(cwd, 'home'),
      accounts: [],
      agentFolders: [cwd],
      agentHomes: [],
    },
  };
  symlinkSync(secret, path.join(cwd, 'AGENTS.md'));
  await expect((await assembleDoeResources(options)).resources.load()).rejects.toThrow('protected');
  rmSync(path.join(cwd, 'AGENTS.md'));
  symlinkSync(secret, path.join(nested, 'AGENTS.md'));
  await expect(
    (await assembleDoeResources(options)).resources.beforeFile(
      path.join(nested, 'ordinary.txt'),
      new AbortController().signal
    )
  ).rejects.toThrow('protected');
});
