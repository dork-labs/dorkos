import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  buildSoulContent,
  composeSoulFile,
  extractCustomProse,
  soulProseBudget,
  defaultSoulTemplate,
  defaultNopeTemplate,
  SOUL_MAX_CHARS,
  NOPE_MAX_CHARS,
  MEMORY_MAX_CHARS,
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
      // ~2K tokens. Red if anyone raises it without re-reading what it costs on
      // codex and opencode, where the append is re-sent uncached every turn.
      expect(MEMORY_MAX_CHARS).toBe(8000);
    });

    it('has correct file names', () => {
      expect(CONVENTION_FILES.soul).toBe('SOUL.md');
      expect(CONVENTION_FILES.nope).toBe('NOPE.md');
      expect(CONVENTION_FILES.memory).toBe('MEMORY.md');
    });

    // Red when: a fourth convention file is added to the record and one of the
    // sites that enumerates them is missed. The set is small and closed on
    // purpose — every entry costs prompt budget on every turn.
    it('is the closed set of three, and the io signatures accept exactly it', () => {
      expect(Object.values(CONVENTION_FILES).sort()).toEqual(['MEMORY.md', 'NOPE.md', 'SOUL.md']);
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

describe('MEMORY.md is a convention file like the other two', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Red when: the closed filename union on `writeConventionFile` is widened
  // without widening `readConventionFile`, or the reverse. It used to be
  // declared by hand on both; a derived type is what makes this pass by
  // construction, and this case is what proves the derivation reaches both.
  it('round-trips through the shared reader and writer', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convention-memory-'));
    await fs.mkdir(path.join(tmpDir, '.dork'), { recursive: true });

    await writeConventionFile(tmpDir, CONVENTION_FILES.memory, '## Notes\n\n- a note\n');
    expect(await readConventionFile(tmpDir, CONVENTION_FILES.memory)).toBe(
      '## Notes\n\n- a note\n'
    );
    expect(await readConventionFile(tmpDir, 'MEMORY.md')).toBe('## Notes\n\n- a note\n');
  });

  it('reads as null when the agent has no memory file yet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convention-memory-'));
    await fs.mkdir(path.join(tmpDir, '.dork'), { recursive: true });

    expect(await readConventionFile(tmpDir, 'MEMORY.md')).toBeNull();
  });
});

describe('composeSoulFile is the one way SOUL.md is put together', () => {
  /** A composed file, as both writers produce it. */
  const composed = (prose: string) => composeSoulFile(prose, { verbosity: 4, spice: 1 });

  it('wraps bare prose in the trait fence', () => {
    const soul = composed('I guard the changelog.');

    expect(soul.startsWith(TRAIT_SECTION_START)).toBe(true);
    expect(soul).toContain(TRAIT_SECTION_END);
    expect(soul).toContain('**Verbosity** (Chatty)');
    expect(soul).toContain('**Spice** (Corporate)');
    expect(soul.endsWith('I guard the changelog.')).toBe(true);
  });

  it('re-composes a whole file into itself', () => {
    const once = composed('I guard the changelog.');

    expect(composed(once)).toBe(once);
  });

  // Red when: the fence is found by looking for an END anywhere, the way
  // `extractCustomProse` does. `kickoff-prompts.ts` teaches every new agent
  // that exact marker string, so a persona that mentions it in passing is not a
  // hypothetical — and slicing at the mention deletes the author's first line
  // without a word.
  it('keeps prose that merely MENTIONS the end marker', () => {
    const prose = [
      'I document my own format.',
      `The block ends at ${TRAIT_SECTION_END}`,
      'Then my real persona starts.',
    ].join('\n');

    const soul = composed(prose);

    expect(soul).toContain('I document my own format.');
    expect(soul).toContain('Then my real persona starts.');
    // And the fence DorkOS wrote is still the first thing in the file.
    expect(soul.indexOf(TRAIT_SECTION_START)).toBe(0);
  });

  it('keeps prose whose markers are the wrong way round', () => {
    const prose = `${TRAIT_SECTION_END} came first, ${TRAIT_SECTION_START} came second.`;

    expect(composeSoulFile(prose, {})).toContain('came first');
  });

  // Text above a real fence is somebody's writing too. Rejoined below rather
  // than dropped, which also keeps the second pass idempotent.
  it('keeps text written ABOVE a real fence', () => {
    const withPreamble = `A note I put on top.\n\n${composed('And my persona below.')}`;

    const soul = composeSoulFile(withPreamble, { verbosity: 4, spice: 1 });

    expect(soul).toContain('A note I put on top.');
    expect(soul).toContain('And my persona below.');
    expect(composeSoulFile(soul, { verbosity: 4, spice: 1 })).toBe(soul);
  });

  it('renders the traits it is given, not the ones the file carried', () => {
    const soul = composeSoulFile(composed('I guard the changelog.'), { verbosity: 1 });

    expect(soul).toContain('**Verbosity** (Mime)');
    expect(soul).not.toContain('**Verbosity** (Chatty)');
  });
});

describe('soulProseBudget is the number an author can act on', () => {
  it('is what is left of the file budget once the block is written', () => {
    const traits = { verbosity: 4, spice: 1 };

    const budget = soulProseBudget(traits);

    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(SOUL_MAX_CHARS);
    // Exact at the boundary, in both directions.
    expect(composeSoulFile('x'.repeat(budget), traits).length).toBe(SOUL_MAX_CHARS);
    expect(composeSoulFile('x'.repeat(budget + 1), traits).length).toBe(SOUL_MAX_CHARS + 1);
  });

  it('differs per agent, because a dial at an extreme renders a longer directive', () => {
    expect(soulProseBudget({ verbosity: 3 })).not.toBe(soulProseBudget({ verbosity: 5 }));
  });
});
