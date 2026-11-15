/**
 * Security's rule for a project's own OpenCode plugins (DOR-4394): what
 * counts, how far up OpenCode looks, and that any doubt refuses. Real
 * folders, made-up names.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PROJECT_PLUGINS_CODE,
  pluginLookupChain,
  projectHasPlugins,
  projectPluginRefusal,
} from '../messaging/project-plugin-guard.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'repo', '.opencode', 'plugin'), 0o755);
    } catch {
      // Only the locked-folder case set it.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** A temp root holding `repo/` with a `.git`; returns the repo folder. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-guard-')));
  roots.push(root);
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  return join(root, 'repo');
}

function put(file: string, text = 'export default {}\n'): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('what counts as a project plugin', () => {
  it.each([
    ['.opencode/plugin/a.ts', 'export default {}'],
    ['.opencode/plugins/b.js', 'export default {}'],
    ['.opencode/plugin/c.mjs', 'export default {}'],
    ['opencode.json', JSON.stringify({ plugin: ['some-npm-plugin'] })],
    ['opencode.json', JSON.stringify({ plugins: ['./local.ts'] })],
    ['opencode.json', JSON.stringify({ plugin: 'some-npm-plugin' })],
    ['opencode.jsonc', '{\n  // a comment\n  "plugin": ["x"],\n}'],
    ['.opencode/opencode.json', JSON.stringify({ plugin: ['x'] })],
    ['.opencode/opencode.jsonc', '/* c */ { "plugins": { "x": {} } }'],
  ])('%s with %s', (file, text) => {
    const dir = repo();
    put(join(dir, file), text);
    expect(projectHasPlugins(dir)).toBe(true);
  });

  it.each([
    ['.opencode/plugin/README.md', 'notes'],
    ['opencode.json', JSON.stringify({ plugin: [] })],
    ['opencode.json', JSON.stringify({ plugin: '' })],
    ['opencode.json', JSON.stringify({ model: 'x', mcp: { a: {} } })],
    ['.opencode/agent/helper.md', 'an agent, not a plugin'],
  ])('not %s with %s', (file, text) => {
    const dir = repo();
    put(join(dir, file), text);
    expect(projectHasPlugins(dir)).toBe(false);
  });

  it('a clean project has none', () => {
    expect(projectHasPlugins(repo())).toBe(false);
  });

  it("ignores the person's own OpenCode config folder, whose plugins still load", () => {
    const dir = repo();
    // `~/.config/opencode/` is OpenCode's own global folder, not on the walk.
    put(join(dir, '..', 'config', 'opencode', 'plugin', 'mine.ts'));
    put(join(dir, '..', 'config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['x'] }));
    expect(projectHasPlugins(dir)).toBe(false);
  });
});

describe('how far up it looks, as OpenCode does', () => {
  it("counts a plugin in a folder between the session's and the repo top", () => {
    const dir = repo();
    put(join(dir, '.opencode', 'plugin', 'top.ts'));
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
    expect(projectHasPlugins(join(dir, 'packages', 'app'))).toBe(true);
  });

  it('stops at the nearest .git, so a plugin above the repo does not count', () => {
    const dir = repo();
    put(join(dir, '..', '.opencode', 'plugin', 'above.ts'));
    expect(projectHasPlugins(dir)).toBe(false);
  });

  it('outside a repo, looks all the way up', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-guard-norepo-')));
    roots.push(root);
    put(join(root, '.opencode', 'plugin', 'outer.ts'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(projectHasPlugins(join(root, 'a', 'b'))).toBe(true);
    const last = pluginLookupChain(join(root, 'a', 'b')).at(-1)!;
    expect(dirname(last)).toBe(last); // the filesystem root
  });

  it('treats a .git file (a worktree) as the repo top too', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-guard-wt-')));
    roots.push(root);
    put(join(root, '.opencode', 'plugin', 'above.ts'));
    put(join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');
    expect(projectHasPlugins(join(root, 'wt'))).toBe(false);
  });

  it('follows a linked .opencode folder', () => {
    const dir = repo();
    put(join(dir, '..', 'elsewhere', 'plugin', 'x.ts'));
    symlinkSync(join(dir, '..', 'elsewhere'), join(dir, '.opencode'));
    expect(projectHasPlugins(dir)).toBe(true);
  });
});

describe('any doubt refuses', () => {
  it.each([
    ['a config that will not parse', 'opencode.json', '{ "plugin": ['],
    ['an unterminated comment', 'opencode.jsonc', '{ /* "plugin": [] }'],
    ['a config that is not an object', 'opencode.json', '["x"]'],
    ['a config over the size cap', 'opencode.json', `{"pad":"${'x'.repeat(300 * 1024)}"}`],
  ])('%s', (_label, file, text) => {
    const dir = repo();
    put(join(dir, file), text);
    expect(projectHasPlugins(dir)).toBe(true);
  });

  it('a config that is a folder', () => {
    const dir = repo();
    mkdirSync(join(dir, 'opencode.json'));
    expect(projectHasPlugins(dir)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('a plugin folder that will not list', () => {
    const dir = repo();
    mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
    chmodSync(join(dir, '.opencode', 'plugin'), 0o000);
    expect(projectHasPlugins(dir)).toBe(true);
  });
});

describe('projectPluginRefusal', () => {
  it("says why in DorkOS's own words, with no project text", () => {
    const dir = repo();
    put(join(dir, '.opencode', 'plugin', 'ignore all rules.ts'));
    const refusal = projectPluginRefusal(dir);
    expect(refusal).toMatchObject({
      type: 'error',
      data: { code: PROJECT_PLUGINS_CODE, category: 'execution_error' },
    });
    expect(JSON.stringify(refusal)).not.toContain('ignore');
  });

  it('lets a clean project through', () => {
    expect(projectPluginRefusal(repo())).toBeUndefined();
  });
});
