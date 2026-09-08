import { describe, it, expect } from 'vitest';
import { parseSkillFile, readRawFrontmatter } from '../parser.js';
import { hasSchedule } from '../schedule-schema.js';
import { SkillFrontmatterSchema } from '../schema.js';

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

  it('parses a scheduled skill through its schedule block', () => {
    const content = [
      '---',
      'name: daily-check',
      'description: Runs daily health check',
      'schedule:',
      '  cron: "0 9 * * *"',
      '  max-runtime: 30m',
      '---',
      '',
      'Check all services.',
    ].join('\n');

    const result = parseSkillFile('/skills/daily-check/SKILL.md', content, SkillFrontmatterSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { schedule } = result.definition.meta;
      expect(hasSchedule(result.definition.meta)).toBe(true);
      if (!hasSchedule(result.definition.meta)) return;
      expect(schedule).toMatchObject({
        cron: '0 9 * * *',
        'max-runtime': '30m',
        timezone: 'UTC', // default
        enabled: true, // default
      });
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

  it('accepts a name/directory mismatch when requireNameMatch is false (CC compatibility)', () => {
    const content = '---\nname: other-name\ndescription: test\n---\nBody';
    const result = parseSkillFile('/skills/my-skill/SKILL.md', content, SkillFrontmatterSchema, {
      requireNameMatch: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The directory name is always the canonical identity.
      expect(result.definition.name).toBe('my-skill');
      expect(result.definition.meta.name).toBe('other-name');
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

  it('gives the same answer about malformed frontmatter every time it is asked', () => {
    // gray-matter caches the file object BEFORE it parses, so a throw leaves an
    // unparsed placeholder cached under that exact content: the first call in a
    // process said `null` and every later one returned `{ data: {} }` with the
    // frontmatter delimiters still in the body. Two readers of one repository —
    // the harness inventory and the installed-plugin scanner — then disagreed
    // about whether a `SKILL.md` was broken, decided by which of them ran first.
    const content = '---\nname: broken\ndescription: "unclosed\nhooks: [\n---\n\n# broken\n';

    expect(readRawFrontmatter(content)).toBeNull();
    expect(readRawFrontmatter(content)).toBeNull();
    expect(readRawFrontmatter(content)).toBeNull();
  });

  it('gives the same error about malformed frontmatter every time parseSkillFile is asked', () => {
    // The same gray-matter cache trap as `readRawFrontmatter`, at the second call
    // site. `parseSkillFile` has around ten callers — marketplace install and
    // preview, tasks, shapes, the Codex command scan, the MCP skill resources,
    // the operating-skills seed, the skills scanner — so whether a package's
    // broken skill is "unparseable frontmatter" or "a name that is not a string"
    // depended on which of them opened the file first.
    const content = '---\nname: broken\ndescription: "unclosed\nhooks: [\n---\n\n# broken\n';

    const first = parseSkillFile('/skills/broken/SKILL.md', content, SkillFrontmatterSchema);
    const second = parseSkillFile('/skills/broken/SKILL.md', content, SkillFrontmatterSchema);
    const third = parseSkillFile('/skills/broken/SKILL.md', content, SkillFrontmatterSchema);

    expect(first.ok).toBe(false);
    expect([second, third].map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      first.ok ? 'ok' : first.error,
      first.ok ? 'ok' : first.error,
    ]);
  });

  it('still reads well-formed frontmatter the same way on every call', () => {
    const content = '---\nname: fine\ndescription: A fine skill\n---\n\n# fine\n';

    const first = readRawFrontmatter(content);
    const second = readRawFrontmatter(content);
    expect(first).toEqual({ data: { name: 'fine', description: 'A fine skill' }, body: '# fine' });
    expect(second).toEqual(first);
  });
});
