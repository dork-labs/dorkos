/**
 * The fixture plugin and repo the `installed-projector*.test.ts` suites plan
 * against. Not a `*.test.ts`, so vitest never collects it as a suite.
 *
 * @module plan/__tests__/installed-projector.fixtures
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHarnessManifest } from '../../manifest/schema.js';
import type { ProjectInstalledPlugin } from '../../sources/installed.js';

/** A manifest enabling Claude Code, Codex and Cursor. */
export const MANIFEST = parseHarnessManifest({
  version: 1,
  harnesses: ['claude-code', 'codex', 'cursor'],
});

/** An empty repo root (no authored skills / AGENTS.md) so only installed projections show. */
export function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'harness-instproj-'));
}

/** A project-installed plugin with two skills, a command and a hook. */
export const projectPlugin: ProjectInstalledPlugin = {
  name: 'acme',
  type: 'plugin',
  location: { scope: 'project', relDir: '.dork/plugins/acme' },
  skills: [
    {
      name: 'alpha',
      sourceDir: '.dork/plugins/acme/skills/alpha',
      usesPluginRoot: false,
      hasSchedule: false,
    },
    {
      name: 'beta',
      sourceDir: '.dork/plugins/acme/.dork/tasks/beta',
      usesPluginRoot: false,
      hasSchedule: false,
    },
  ],
  commands: [
    {
      name: 'capture',
      sourcePath: '.dork/plugins/acme/commands/capture.md',
      content: '---\ndescription: cap\n---\nRead `${CLAUDE_PLUGIN_ROOT}/skills/x/SKILL.md`.\n',
    },
  ],
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-plugin' }] }] },
  layers: ['commands', 'skills', 'tasks', 'hooks', 'extensions', 'mcp-servers'],
};
