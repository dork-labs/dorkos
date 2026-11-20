/**
 * Every agent-facing text about building a mini app tells the same five-point story (DOR-4854).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import { extensionToolDefinitions } from '../../../runtimes/claude-code/mcp-tools/extension-tools.js';
import { buildDorkosAreasBlock } from '../../../runtimes/shared/awareness/dorkos-areas.js';
import { MINI_APP_STORY, MINI_APP_STORY_SECTION, MINI_APP_STORY_TEXT } from '../mini-app-story.js';

/** One phrase that must appear in each point, in order. */
const POINTS = [
  'writable only in an unmarked turn',
  'personal marketplace',
  'Never hand anyone a shell command',
  'waitsForPerson: true',
  'Settings > Add-ons',
] as const;

const deps = {
  transcriptReader: {},
  defaultCwd: '/made-up',
} as unknown as McpToolDeps;

/** A tool from the extension tool set, by name. */
function toolNamed(name: string) {
  const found = extensionToolDefinitions(deps).find((t) => t.name === name);
  if (!found) throw new Error(`${name} is not defined`);
  return found;
}

describe('the mini app story', () => {
  it('says all five points, one per sentence, in order', () => {
    expect(MINI_APP_STORY).toHaveLength(POINTS.length);
    POINTS.forEach((phrase, index) => expect(MINI_APP_STORY[index]).toContain(phrase));
  });

  it('is in create_extension’s description word for word', () => {
    expect(toolNamed('create_extension').description).toContain(MINI_APP_STORY_TEXT);
  });

  it('opens what get_extension_api returns', async () => {
    const result = (await toolNamed('get_extension_api').handler({} as never, undefined)) as {
      content: { text: string }[];
    };
    const text = result.content[0]!.text;
    expect(text).toContain(MINI_APP_STORY_SECTION);
    expect(text.indexOf(MINI_APP_STORY_SECTION)).toBeLessThan(text.indexOf('## Client-Side'));
  });

  it('is named in the DorkOS block’s Tools line, which has no room for more', () => {
    expect(buildDorkosAreasBlock()).toContain('build mini apps a person approves');
  });

  /** The repo root, from this test's folder. */
  const ROOT = path.resolve(import.meta.dirname, '../../../../../../..');
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

  it('is in the building-dorkos-apps skill, point by point', () => {
    const skill = ['SKILL.md', 'personal-marketplace.md']
      .map((file) =>
        read(
          `packages/operating-skills/src/skills/app-builder-pack/skills/building-dorkos-apps/${file}`
        )
      )
      .join('\n');
    for (const phrase of [
      'folder is read-only',
      'personal marketplace',
      'shell command',
      'waitsForPerson: true',
      'Settings > Add-ons',
    ])
      expect(skill).toContain(phrase);
  });

  it('is in the docs page on extensions, point by point', () => {
    const docs = read('docs/integrations/extensions.mdx');
    for (const phrase of [
      "can't change files in that folder",
      'personal marketplace',
      'never asks you to run a command',
      'Turn on <app>?',
      'Settings → Add-ons',
    ])
      expect(docs).toContain(phrase);
  });
});
