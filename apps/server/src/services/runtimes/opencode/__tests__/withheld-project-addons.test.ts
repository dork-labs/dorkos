/**
 * DorkOS's own count of what a project's OpenCode config would have added,
 * now that the shared sidecar loads none of it (DOR-4404). Real folders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withheldProjectAddons } from '../messaging/withheld-project-addons.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-withheld-')));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  return root;
}

function put(file: string, text = 'export default {}\n'): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

describe('withheldProjectAddons', () => {
  it('counts plugin and tool files, config plugins and MCP servers', () => {
    const root = repo();
    put(join(root, '.opencode', 'plugin', 'a.ts'));
    put(join(root, '.opencode', 'plugins', 'b.js'));
    put(join(root, '.opencode', 'plugin', 'README.md'), 'not code');
    put(join(root, '.opencode', 'tool', 'c.ts'));
    put(
      join(root, 'opencode.jsonc'),
      `{
        // a comment, and a trailing comma
        "plugin": ["opencode-x"],
        "mcp": { "one": { "type": "local" }, "two": { "url": "http://a//b" }, },
      }`
    );
    put(join(root, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { three: {} } }));

    expect(withheldProjectAddons(root)).toEqual({ plugins: 3, tools: 1, mcpServers: 3 });
  });

  it("counts every folder from the project's top down to the session's, and nothing above", () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'oc-withheld-above-')));
    roots.push(outer);
    put(join(outer, '.opencode', 'plugin', 'above.ts'));
    const root = join(outer, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    put(join(root, '.opencode', 'plugin', 'top.ts'));
    const deep = join(root, 'packages', 'app');
    put(join(deep, '.opencode', 'tool', 'deep.ts'));

    expect(withheldProjectAddons(deep)).toEqual({ plugins: 1, tools: 1, mcpServers: 0 });
  });

  it('says nothing for a project with no add-ons', () => {
    const root = repo();
    put(join(root, 'opencode.json'), JSON.stringify({ model: 'x' }));
    expect(withheldProjectAddons(root)).toBeUndefined();
  });

  it('adds nothing for a config file that will not parse or is too big', () => {
    const root = repo();
    put(join(root, 'opencode.json'), '{ "mcp": { "a": {} ');
    put(join(root, 'opencode.jsonc'), `{"mcp":{"a":{}},"pad":"${'x'.repeat(300 * 1024)}"}`);
    expect(withheldProjectAddons(root)).toBeUndefined();
  });
});
