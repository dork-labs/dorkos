import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  buildSoulContent,
  extractCustomProse,
  defaultSoulTemplate,
  defaultNopeTemplate,
  SOUL_MAX_CHARS,
  NOPE_MAX_CHARS,
  TRAIT_SECTION_START,
  TRAIT_SECTION_END,
  CONVENTION_FILES,
} from '../convention-files.js';
import { readConventionFile, writeConventionFile } from '../convention-files-io.js';

describe('convention-files', () => {
  describe('constants', () => {
    it('has correct character limits', () => {
      expect(SOUL_MAX_CHARS).toBe(4000);
      expect(NOPE_MAX_CHARS).toBe(2000);
    });

    it('has correct file names', () => {
      expect(CONVENTION_FILES.soul).toBe('SOUL.md');
      expect(CONVENTION_FILES.nope).toBe('NOPE.md');
    });
  });

  describe('buildSoulContent', () => {
    it('creates structure with trait markers and custom prose', () => {
      const result = buildSoulContent('trait-block-here', 'custom prose here');
      expect(result).toContain(TRAIT_SECTION_START);
      expect(result).toContain(TRAIT_SECTION_END);
      expect(result).toContain('## Personality Traits');
      expect(result).toContain('trait-block-here');
      expect(result).toContain('custom prose here');
    });

    it('omits custom prose section when empty', () => {
      const result = buildSoulContent('trait-block', '');
      expect(result).toContain(TRAIT_SECTION_START);
      expect(result).toContain(TRAIT_SECTION_END);
      expect(result).not.toContain('\n\n\n'); // no double-blank from empty prose
    });

    it('omits custom prose section when whitespace-only', () => {
      const result = buildSoulContent('trait-block', '   \n  ');
      const afterEnd = result.split(TRAIT_SECTION_END)[1];
      expect(afterEnd?.trim()).toBe('');
    });
  });

  describe('extractCustomProse', () => {
    it('extracts prose after TRAITS:END marker', () => {
      const content = `${TRAIT_SECTION_START}\ntraits here\n${TRAIT_SECTION_END}\n\n## Identity\n\nI am an agent.`;
      const result = extractCustomProse(content);
      expect(result).toBe('## Identity\n\nI am an agent.');
    });

    it('returns full content when no trait markers present', () => {
      const content = '## Identity\n\nI am a legacy agent.';
      const result = extractCustomProse(content);
      expect(result).toBe(content);
    });

    it('returns empty string when no prose after markers', () => {
      const content = `${TRAIT_SECTION_START}\ntraits\n${TRAIT_SECTION_END}`;
      const result = extractCustomProse(content);
      expect(result).toBe('');
    });
  });

  describe('defaultSoulTemplate', () => {
    it('includes agent name in identity section', () => {
      const result = defaultSoulTemplate('test-bot', 'trait-block');
      expect(result).toContain('You are test-bot, a coding assistant.');
    });

    it('includes trait markers', () => {
      const result = defaultSoulTemplate('test-bot', 'trait-block');
      expect(result).toContain(TRAIT_SECTION_START);
      expect(result).toContain(TRAIT_SECTION_END);
    });

    it('includes default values section', () => {
      const result = defaultSoulTemplate('test-bot', 'trait-block');
      expect(result).toContain('## Values');
      expect(result).toContain('Write clean, maintainable code');
    });
  });

  describe('defaultNopeTemplate', () => {
    it('includes Safety Boundaries heading', () => {
      const result = defaultNopeTemplate();
      expect(result).toContain('# Safety Boundaries');
    });

    it('includes Never Do rules', () => {
      const result = defaultNopeTemplate();
      expect(result).toContain('Never push to main/master');
      expect(result).toContain('Never delete production data');
      expect(result).toContain('Never commit secrets');
    });

    it('includes Always Do rules', () => {
      const result = defaultNopeTemplate();
      expect(result).toContain('Always create a new branch');
      expect(result).toContain('Always run tests before committing');
    });
  });

  describe('readConventionFile and writeConventionFile', () => {
    const tempDirs: string[] = [];

    async function makeTempDir(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'convention-files-test-'));
      tempDirs.push(dir);
      return dir;
    }

    afterEach(async () => {
      for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('readConventionFile returns null when file does not exist', async () => {
      const projectDir = await makeTempDir();
      const result = await readConventionFile(projectDir, 'SOUL.md');
      expect(result).toBeNull();
    });

    it('readConventionFile returns null when .dork directory does not exist', async () => {
      const projectDir = await makeTempDir();
      const result = await readConventionFile(projectDir, 'NOPE.md');
      expect(result).toBeNull();
    });

    it('writeConventionFile writes to {projectPath}/.dork/{filename}', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });
      await writeConventionFile(projectDir, 'SOUL.md', 'hello world');

      const content = await fs.readFile(path.join(projectDir, '.dork', 'SOUL.md'), 'utf-8');
      expect(content).toBe('hello world');
    });

    it('readConventionFile reads from {projectPath}/.dork/{filename}', async () => {
      const projectDir = await makeTempDir();
      const dorkDir = path.join(projectDir, '.dork');
      await fs.mkdir(dorkDir, { recursive: true });
      await fs.writeFile(path.join(dorkDir, 'SOUL.md'), 'my soul content', 'utf-8');

      const result = await readConventionFile(projectDir, 'SOUL.md');
      expect(result).toBe('my soul content');
    });

    it('round-trips SOUL.md content', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });
      const content = defaultSoulTemplate('test-agent', 'trait-block');

      await writeConventionFile(projectDir, 'SOUL.md', content);
      const result = await readConventionFile(projectDir, 'SOUL.md');

      expect(result).toBe(content);
    });

    it('round-trips NOPE.md content', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });
      const content = defaultNopeTemplate();

      await writeConventionFile(projectDir, 'NOPE.md', content);
      const result = await readConventionFile(projectDir, 'NOPE.md');

      expect(result).toBe(content);
    });
  });
});
