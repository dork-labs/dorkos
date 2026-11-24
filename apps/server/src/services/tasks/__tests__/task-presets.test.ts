import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadPresets, ensureDefaultPresets, getDefaultPresets } from '../task-presets.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

vi.mock('node:fs/promises');

const DORK_HOME = '/home/user/.dork';
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('task-presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadPresets', () => {
    it('loads presets from the JSON file', async () => {
      const presets = [
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
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(presets));

      expect(await loadPresets(DORK_HOME)).toEqual(presets);
      expect(readFile).toHaveBeenCalledWith(path.join(DORK_HOME, 'tasks', 'presets.json'), 'utf-8');
    });

    it('returns the defaults when the file does not exist', async () => {
      vi.mocked(readFile).mockRejectedValue(enoent());
      expect(await loadPresets(DORK_HOME)).toEqual(getDefaultPresets());
    });

    it.each([
      ['malformed JSON', 'not valid json {{'],
      ['JSON that is not an array', '{"key": "value"}'],
    ])('returns an empty list for %s', async (_label, content) => {
      vi.mocked(readFile).mockResolvedValue(content);
      expect(await loadPresets(DORK_HOME)).toEqual([]);
    });
  });

  describe('ensureDefaultPresets', () => {
    it('writes the defaults when the file does not exist', async () => {
      vi.mocked(readFile).mockRejectedValue(enoent());

      await ensureDefaultPresets(DORK_HOME);

      const [file, written] = vi.mocked(writeFile).mock.calls[0]!;
      expect(file).toBe(path.join(DORK_HOME, 'tasks', 'presets.json'));
      expect(JSON.parse(written as string)).toEqual(getDefaultPresets());
    });

    it('never overwrites an existing file, even an empty list', async () => {
      vi.mocked(readFile).mockResolvedValue('[]');

      await ensureDefaultPresets(DORK_HOME);

      expect(writeFile).not.toHaveBeenCalled();
    });
  });
});
