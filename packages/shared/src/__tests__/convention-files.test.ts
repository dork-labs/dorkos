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
  SOUL_MAX_CHARS,
  TRAIT_SECTION_START,
  TRAIT_SECTION_END,
  CONVENTION_FILES,
} from '../convention-files.js';
import {
  readConventionFile,
  writeConventionFile,
  writeConventionFileIfAbsent,
} from '../convention-files-io.js';

describe('convention-files', () => {
  describe('constants', () => {
    // Red when: a fifth convention file is added to the record and one of the
    // sites that enumerates them is missed. The set is small and closed on
    // purpose. Three of the four cost prompt budget on every turn; HEARTBEAT.md
    // is read by beats only (spec `heartbeats` §2), which `agent-context.test.ts`
    // pins.
    it('is the closed set of four, and the io signatures accept exactly it', () => {
      expect(Object.values(CONVENTION_FILES).sort()).toEqual([
        'HEARTBEAT.md',
        'MEMORY.md',
        'NOPE.md',
        'SOUL.md',
      ]);
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
  });

  describe('extractCustomProse', () => {
    it('extracts prose after TRAITS:END marker', () => {
      const content = `${TRAIT_SECTION_START}\ntraits here\n${TRAIT_SECTION_END}\n\n## Identity\n\nI am an agent.`;
      const result = extractCustomProse(content);
      expect(result).toBe('## Identity\n\nI am an agent.');
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

    // Purpose (DOR-2245): a marketplace agent's persona and memory are the
    // agent's; the scaffold may seed a missing file but never replace one.
    it('writeConventionFileIfAbsent writes a missing file and reports it', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });

      expect(await writeConventionFileIfAbsent(projectDir, 'MEMORY.md', 'seed')).toBe(true);
      expect(await fs.readFile(path.join(projectDir, '.dork', 'MEMORY.md'), 'utf-8')).toBe('seed');
    });

    it('writeConventionFileIfAbsent leaves an existing file byte-identical', async () => {
      const projectDir = await makeTempDir();
      const file = path.join(projectDir, '.dork', 'SOUL.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'my edited persona', 'utf-8');

      expect(await writeConventionFileIfAbsent(projectDir, 'SOUL.md', 'default')).toBe(false);
      expect(await fs.readFile(file, 'utf-8')).toBe('my edited persona');
    });

    // Purpose: two concurrent seeders write once, and the file holds one of them whole.
    it('writeConventionFileIfAbsent writes once under concurrent calls', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });

      const results = await Promise.all([
        writeConventionFileIfAbsent(projectDir, 'NOPE.md', 'first'),
        writeConventionFileIfAbsent(projectDir, 'NOPE.md', 'second'),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const content = await fs.readFile(path.join(projectDir, '.dork', 'NOPE.md'), 'utf-8');
      expect(['first', 'second']).toContain(content);
    });

    it('round-trips SOUL.md content', async () => {
      const projectDir = await makeTempDir();
      await fs.mkdir(path.join(projectDir, '.dork'), { recursive: true });
      const content = defaultSoulTemplate('test-agent', 'trait-block');

      await writeConventionFile(projectDir, 'SOUL.md', content);
      const result = await readConventionFile(projectDir, 'SOUL.md');

      expect(result).toBe(content);
    });

    // Purpose: an empty file is still the agent's (an emptied memory is a choice).
    it('writeConventionFileIfAbsent leaves an existing empty file alone', async () => {
      const projectDir = await makeTempDir();
      const file = path.join(projectDir, '.dork', 'MEMORY.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '', 'utf-8');

      expect(await writeConventionFileIfAbsent(projectDir, 'MEMORY.md', 'seed')).toBe(false);
      expect(await fs.readFile(file, 'utf-8')).toBe('');
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

  // Text above a real fence is somebody's writing too. Rejoined below rather
  // than dropped, which also keeps the second pass idempotent.
  it('keeps text written ABOVE a real fence', () => {
    const withPreamble = `A note I put on top.\n\n${composed('And my persona below.')}`;

    const soul = composeSoulFile(withPreamble, { verbosity: 4, spice: 1 });

    expect(soul).toContain('A note I put on top.');
    expect(soul).toContain('And my persona below.');
    expect(composeSoulFile(soul, { verbosity: 4, spice: 1 })).toBe(soul);
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
});
