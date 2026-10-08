/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleDoeResources } from '../resources.js';
const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'doe-resources-')));
  roots.push(root);
  return root;
}
async function skill(root: string, name: string, body: string) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`
  );
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('direct Doe resources', () => {
  it('reads project, user and own metadata lazily with explicit precedence and operating fallback', async () => {
    const root = await fixture(),
      cwd = path.join(root, 'desk'),
      home = path.join(root, 'agent'),
      user = path.join(root, 'user');
    await mkdir(cwd);
    await mkdir(home);
    await writeFile(path.join(root, 'AGENTS.md'), 'ancestor guidance');
    await writeFile(path.join(home, 'AGENTS.md'), 'own guidance');
    await skill(path.join(cwd, '.agents/skills'), 'project-skill', 'PROJECT BODY');
    await skill(user, 'user-skill', 'USER BODY');
    await skill(user, 'project-skill', 'SHADOWED BODY');
    await skill(path.join(home, '.agents/skills'), 'own-skill', 'OWN BODY');
    const { resources } = await assembleDoeResources({
      cwd,
      agentPath: home as never,
      userSkillsDir: user,
      dorkHome: path.join(root, 'dork'),
    });
    const context = await resources.load();
    expect(context).toContain('ancestor guidance');
    expect(context).toContain('own guidance');
    for (const name of ['project-skill', 'user-skill', 'own-skill', 'operating-dorkos'])
      expect((await resources.skills()).some((item) => item.name === name)).toBe(true);
    expect(context).not.toContain('PROJECT BODY');
    expect(context).not.toContain('USER BODY');
    expect(context).not.toContain('OWN BODY');
    expect(await resources.loadSkill('project-skill', new AbortController().signal)).toContain(
      'PROJECT BODY'
    );
    expect(await resources.loadSkill('project-skill', new AbortController().signal)).not.toContain(
      'SHADOWED BODY'
    );
    expect(await resources.loadSkill('user-skill', new AbortController().signal)).toContain(
      'USER BODY'
    );
  });
  it('loads nested instructions before access and resets absent grants each assembly', async () => {
    const root = await fixture(),
      cwd = path.join(root, 'desk'),
      extra = path.join(root, 'extra'),
      nested = path.join(cwd, 'nested');
    await mkdir(nested, { recursive: true });
    await mkdir(extra);
    await writeFile(path.join(nested, 'AGENTS.md'), 'nested guidance');
    await writeFile(path.join(nested, 'file.txt'), 'data');
    const first = await assembleDoeResources({
      cwd,
      userSkillsDir: path.join(root, 'none'),
      dorkHome: path.join(root, 'dork'),
      additionalDirectories: [{ path: extra, access: 'read' }],
    });
    expect(
      await first.resources.beforeFile(path.join(nested, 'file.txt'), new AbortController().signal)
    ).toContain('nested guidance');
    expect(first.pathPolicy.readRoots).toContain(extra);
    expect(first.pathPolicy.writeRoots).not.toContain(extra);
    const second = await assembleDoeResources({
      cwd,
      userSkillsDir: path.join(root, 'none'),
      dorkHome: path.join(root, 'dork'),
    });
    expect(second.pathPolicy.readRoots).not.toContain(extra);
  });
  it('RT-PLG-01: uses real installed plugin namespaces and expands both portable root placeholders', async () => {
    const root = await fixture(),
      install = path.join(root, '.dork/plugins/test-plugin');
    await mkdir(path.join(install, '.dork'), { recursive: true });
    await writeFile(
      path.join(install, '.dork/manifest.json'),
      JSON.stringify({
        name: 'test-plugin',
        version: '1.0.0',
        type: 'plugin',
        description: 'test plugin',
      })
    );
    await skill(
      path.join(install, 'skills'),
      'plugin-skill',
      '${CLAUDE_PLUGIN_ROOT}/script.js ${CLAUDE_PLUGIN_DATA}/state'
    );
    const { resources } = await assembleDoeResources({
      cwd: root,
      userSkillsDir: path.join(root, 'none'),
      dorkHome: path.join(root, 'dork'),
    });
    expect(
      (await resources.skills()).some((item) => item.name === 'test-plugin:plugin-skill')
    ).toBe(true);
    expect(
      await resources.loadSkill('test-plugin:plugin-skill', new AbortController().signal)
    ).toContain(`${install}/script.js ${install}/.dork/data/state`);
  });
});

it('preserves future folder grants and clears them on the next ungranted turn', async () => {
  const root = await fixture(),
    cwd = path.join(root, 'desk'),
    future = path.join(root, 'not-created-yet');
  await mkdir(cwd);
  const first = await assembleDoeResources({
    cwd,
    additionalDirectories: [{ path: future, access: 'write' }],
    userSkillsDir: path.join(root, 'none'),
    dorkHome: path.join(root, 'dork'),
  });
  expect(first.pathPolicy.readRoots).toContain(future);
  expect(first.pathPolicy.writeRoots).toContain(future);
  const next = await assembleDoeResources({
    cwd,
    userSkillsDir: path.join(root, 'none'),
    dorkHome: path.join(root, 'dork'),
  });
  expect(next.pathPolicy.readRoots).not.toContain(future);
  expect(next.pathPolicy.writeRoots).not.toContain(future);
});
