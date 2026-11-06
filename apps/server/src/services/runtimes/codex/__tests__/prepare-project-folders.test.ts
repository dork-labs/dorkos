import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareProjectFolders } from '../policy/prepare-project-folders.js';
import type { CodexFilePolicy } from '../policy/protected-profile.js';
import { prepareCodexFilePolicy } from '../transport/prepare-file-policy.js';
import { completeHostFixture } from '../app-server/__tests__/fixtures/complete-protected-home.js';
import { makeAppServerHarness } from './app-server-harness.js';

let root: string;
let policy: CodexFilePolicy;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-folders-')));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'person');
  const agent = path.join(root, 'agent');
  for (const dir of [cwd, home, agent]) fs.mkdirSync(dir);
  policy = {
    roots: { cwd, home, data: root, accounts: [], agentFolders: [agent], agentHomes: [agent] },
    writable: [cwd, agent],
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

it('creates only exact project and own-folder directories and leaves them in place', () => {
  prepareProjectFolders(policy);
  for (const dir of [policy.roots.cwd, ...policy.roots.agentFolders]) {
    expect(fs.readdirSync(dir).sort()).toEqual(['.claude', '.dork']);
    for (const name of ['.claude', '.dork'])
      expect(fs.lstatSync(path.join(dir, name)).isDirectory()).toBe(true);
  }
  const inode = fs.lstatSync(path.join(policy.roots.cwd, '.claude')).ino;
  prepareProjectFolders(policy);
  expect(fs.lstatSync(path.join(policy.roots.cwd, '.claude')).ino).toBe(inode);
  expect(fs.readdirSync(policy.roots.home)).toEqual([]);
});

it('leaves an existing symbolic link and its destination untouched, and refuses', () => {
  const target = path.join(policy.roots.cwd, '.claude');
  fs.symlinkSync(policy.roots.home, target);
  expect(() => prepareProjectFolders(policy)).toThrow('linked folder');
  expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(target)).toBe(policy.roots.home);
  expect(fs.readdirSync(policy.roots.home)).toEqual([]);
  expect(fs.readdirSync(policy.roots.cwd)).toEqual(['.claude']);
});

it('preserves a person’s existing regular file for the existing layout refusal', () => {
  const file = path.join(policy.roots.cwd, '.claude');
  fs.writeFileSync(file, 'person');
  const before = fs.lstatSync(file).ino;
  prepareProjectFolders(policy);
  expect(fs.lstatSync(file).ino).toBe(before);
  expect(fs.readFileSync(file, 'utf8')).toBe('person');
});

it('refuses a linked parent before creating anything through it', () => {
  const alias = path.join(root, 'alias');
  fs.symlinkSync(policy.roots.cwd, alias);
  policy.roots.cwd = alias;
  expect(() => prepareProjectFolders(policy)).toThrow('without links');
  expect(fs.readdirSync(fs.realpathSync(alias))).toEqual([]);
});

it('refuses a filesystem root before mkdir', () => {
  policy.roots.cwd = path.parse(root).root;
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  try {
    expect(() => prepareProjectFolders(policy)).toThrow('without links');
    expect(mkdir).not.toHaveBeenCalled();
  } finally {
    mkdir.mockRestore();
  }
});

it.each(['acceptEdits', 'bypassPermissions'])(
  'prepares a fresh project at %s when the remaining targets already exist',
  async (permissionMode) => {
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'linux' : Reflect.get(target, key)),
      })
    );
    completeHostFixture(policy, [policy.roots.home, policy.roots.data, ...policy.roots.agentHomes]);
    expect(fs.readdirSync(policy.roots.cwd)).toEqual([]);
    const h = makeAppServerHarness();
    try {
      await prepareCodexFilePolicy(
        h.request({
          sessionId: 'fresh-project',
          cwd: policy.roots.cwd,
          settings: { permissionMode },
          tools: {
            agentTokenEnv: {},
            managed: { servers: {}, env: {} },
            dorkosTools: null,
            connectorTools: null,
            filePolicy: policy,
          },
        })
      );
      expect(fs.readdirSync(policy.roots.cwd).sort()).toEqual(['.claude', '.dork']);
      for (const name of ['.claude', '.dork'])
        expect(fs.readdirSync(path.join(policy.roots.cwd, name))).toEqual([]);
    } finally {
      await h.pool.shutdown();
    }
  }
);
