import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../parser.js';
import { SkillFrontmatterSchema } from '../schema.js';
import { TaskFrontmatterSchema } from '../task-schema.js';

describe('parseSkillFile', () => {
  it('parses valid SKILL.md with base schema', () => {
    const content = [
      '---',
      'name: my-skill',
      'description: A useful skill',
      '---',
      '',
      'Do the thing.',
    ].join('\n');

    const result = parseSkillFile('/skills/my-skill/SKILL.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.name).toBe('my-skill');
      expect(result.definition.meta.name).toBe('my-skill');
      expect(result.definition.meta.description).toBe('A useful skill');
      expect(result.definition.body).toBe('Do the thing.');
      expect(result.definition.filePath).toBe('/skills/my-skill/SKILL.md');
      expect(result.definition.dirPath).toBe('/skills/my-skill');
    }
  });

  it('parses valid SKILL.md with task schema', () => {
    const content = [
      '---',
      'name: daily-check',
      'description: Runs daily health check',
      'cron: "0 9 * * *"',
      'max-runtime: 30m',
      '---',
      '',
      'Check all services.',
    ].join('\n');

    const result = parseSkillFile('/tasks/daily-check/SKILL.md', content, TaskFrontmatterSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.meta.cron).toBe('0 9 * * *');
      expect(result.definition.meta['max-runtime']).toBe('30m');
      expect(result.definition.meta.timezone).toBe('UTC'); // default
      expect(result.definition.meta.enabled).toBe(true); // default
    }
  });

  it('returns error for wrong filename', () => {
    const content = '---\nname: test\ndescription: test\n---\nBody';
    const result = parseSkillFile('/skills/test/README.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Expected filename');
      expect(result.error).toContain('README.md');
    }
  });

  it('returns error for invalid frontmatter (missing required field)', () => {
    const content = '---\nname: test\n---\nBody';
    const result = parseSkillFile('/skills/test/SKILL.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid frontmatter');
    }
  });

  it('returns error for name/directory mismatch', () => {
    const content = '---\nname: other-name\ndescription: test\n---\nBody';
    const result = parseSkillFile('/skills/my-skill/SKILL.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not match directory name');
    }
  });

  it('handles empty body gracefully', () => {
    const content = '---\nname: empty\ndescription: No body\n---\n';
    const result = parseSkillFile('/skills/empty/SKILL.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.body).toBe('');
    }
  });

  it('handles malformed YAML', () => {
    const content = '---\n: invalid yaml [\n---\nBody';
    const result = parseSkillFile('/skills/bad/SKILL.md', content, SkillFrontmatterSchema);

    // gray-matter may or may not throw on this — if it parses but produces
    // invalid data, the schema validation will catch it. Either way, ok should be false.
    expect(result.ok).toBe(false);
  });
});
