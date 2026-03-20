import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPresets, ensureDefaultPresets, getDefaultPresets } from '../pulse-presets.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

vi.mock('node:fs/promises');
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('pulse-presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDefaultPresets', () => {
    it('returns 4 default presets', () => {
      const presets = getDefaultPresets();
      expect(presets).toHaveLength(4);
    });

    it('returns presets with required fields', () => {
      const presets = getDefaultPresets();
      for (const preset of presets) {
        expect(preset.id).toBeDefined();
        expect(preset.name).toBeDefined();
        expect(preset.description).toBeDefined();
        expect(preset.prompt).toBeDefined();
        expect(preset.cron).toBeDefined();
        expect(preset.timezone).toBe('UTC');
        expect(preset.category).toBeDefined();
      }
    });

    it('includes health-check preset', () => {
      const presets = getDefaultPresets();
      const healthCheck = presets.find((p) => p.id === 'health-check');
      expect(healthCheck).toBeDefined();
      expect(healthCheck!.cron).toBe('0 8 * * 1');
      expect(healthCheck!.category).toBe('maintenance');
    });

    it('includes dependency-audit preset', () => {
      const presets = getDefaultPresets();
      const audit = presets.find((p) => p.id === 'dependency-audit');
      expect(audit).toBeDefined();
      expect(audit!.cron).toBe('0 9 * * 1');
      expect(audit!.category).toBe('security');
    });

    it('includes docs-sync preset', () => {
      const presets = getDefaultPresets();
      const docs = presets.find((p) => p.id === 'docs-sync');
      expect(docs).toBeDefined();
      expect(docs!.cron).toBe('0 10 * * *');
      expect(docs!.category).toBe('documentation');
    });

    it('includes code-review preset', () => {
      const presets = getDefaultPresets();
      const review = presets.find((p) => p.id === 'code-review');
      expect(review).toBeDefined();
      expect(review!.cron).toBe('0 8 * * 5');
      expect(review!.category).toBe('quality');
    });

    it('returns a copy (not a reference)', () => {
      const a = getDefaultPresets();
      const b = getDefaultPresets();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('all presets have valid cron expressions (5 fields)', () => {
      const presets = getDefaultPresets();
      const cronRegex = /^(\S+\s+){4}\S+$/;
      for (const preset of presets) {
        expect(preset.cron).toMatch(cronRegex);
      }
    });

    it('all preset IDs are unique', () => {
      const presets = getDefaultPresets();
      const ids = presets.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all presets have non-empty prompts', () => {
      const presets = getDefaultPresets();
      for (const preset of presets) {
        expect(preset.prompt.length).toBeGreaterThan(0);
      }
    });

    it('mutations to returned array do not affect future calls', () => {
      const first = getDefaultPresets();
      first.push({
        id: 'extra',
        name: 'Extra',
        description: 'd',
        prompt: 'p',
        cron: '* * * * *',
        timezone: 'UTC',
        category: 'test',
      });

      const second = getDefaultPresets();
      expect(second).toHaveLength(4);
    });
  });

  describe('loadPresets', () => {
    it('loads presets from JSON file', async () => {
      const mockPresets = [
        {
          id: 'custom',
          name: 'Custom',
          description: 'd',
          prompt: 'p',
          cron: '* * * * *',
          timezone: 'UTC',
          category: 'test',
        },
      ];
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockPresets));

      const result = await loadPresets('/home/user/.dork');
      expect(result).toEqual(mockPresets);
      expect(readFile).toHaveBeenCalledWith(
        path.join('/home/user/.dork', 'pulse', 'presets.json'),
        'utf-8'
      );
    });

    it('returns default presets when file does not exist', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);

      const result = await loadPresets('/home/user/.dork');
      expect(result).toEqual(getDefaultPresets());
      expect(result).toHaveLength(4);
    });

    it('returns empty array for malformed JSON', async () => {
      vi.mocked(readFile).mockResolvedValue('not valid json {{');

      const result = await loadPresets('/home/user/.dork');
      expect(result).toEqual([]);
    });

    it('returns empty array when file contains non-array JSON', async () => {
      vi.mocked(readFile).mockResolvedValue('{"key": "value"}');

      const result = await loadPresets('/home/user/.dork');
      expect(result).toEqual([]);
    });

    it('returns empty array on unexpected read errors', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('EPERM'));

      const result = await loadPresets('/home/user/.dork');
      expect(result).toEqual([]);
    });
  });

  describe('ensureDefaultPresets', () => {
    it('creates default presets when file does not exist', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);
      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue();

      await ensureDefaultPresets('/home/user/.dork');

      expect(mkdir).toHaveBeenCalledWith(path.join('/home/user/.dork', 'pulse'), {
        recursive: true,
      });
      expect(writeFile).toHaveBeenCalledWith(
        path.join('/home/user/.dork', 'pulse', 'presets.json'),
        expect.any(String),
        'utf-8'
      );

      // Verify the written content is valid JSON with 4 presets
      const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed).toHaveLength(4);
    });

    it('does not overwrite existing presets file', async () => {
      vi.mocked(readFile).mockResolvedValue('[]');

      await ensureDefaultPresets('/home/user/.dork');

      expect(writeFile).not.toHaveBeenCalled();
    });

    it('handles non-ENOENT errors gracefully', async () => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      vi.mocked(readFile).mockRejectedValue(err);

      // Should not throw
      await ensureDefaultPresets('/home/user/.dork');

      expect(writeFile).not.toHaveBeenCalled();
    });

    it('creates pulse/ subdirectory with recursive flag', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);
      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue();

      await ensureDefaultPresets('/custom/path');

      expect(mkdir).toHaveBeenCalledWith(path.join('/custom/path', 'pulse'), { recursive: true });
    });

    it('written JSON is valid and matches default presets', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);
      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue();

      await ensureDefaultPresets('/home/user/.dork');

      const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      // Each preset should have all required fields
      for (const preset of parsed) {
        expect(preset).toHaveProperty('id');
        expect(preset).toHaveProperty('name');
        expect(preset).toHaveProperty('description');
        expect(preset).toHaveProperty('prompt');
        expect(preset).toHaveProperty('cron');
        expect(preset).toHaveProperty('timezone');
        expect(preset).toHaveProperty('category');
      }

      // Should match getDefaultPresets output
      expect(parsed).toEqual(getDefaultPresets());
    });

    it('does not write when file exists even with empty array', async () => {
      vi.mocked(readFile).mockResolvedValue('[]');

      await ensureDefaultPresets('/home/user/.dork');

      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('loadPresets edge cases', () => {
    it('handles empty string file content', async () => {
      vi.mocked(readFile).mockResolvedValue('');

      const result = await loadPresets('/home/user/.dork');
      // Empty string is invalid JSON -> SyntaxError -> empty array
      expect(result).toEqual([]);
    });

    it('handles file with null JSON value', async () => {
      vi.mocked(readFile).mockResolvedValue('null');

      const result = await loadPresets('/home/user/.dork');
      // null is not an array
      expect(result).toEqual([]);
    });

    it('reads from correct path under dorkHome', async () => {
      vi.mocked(readFile).mockResolvedValue('[]');

      await loadPresets('/custom/dork/home');

      expect(readFile).toHaveBeenCalledWith(
        path.join('/custom/dork/home', 'pulse', 'presets.json'),
        'utf-8'
      );
    });
  });
});
