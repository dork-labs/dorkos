import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertDocker,
  parseOptions,
  parseProcess,
  parseSmaps,
  ownedProcesses,
  summarize,
} from '../chat-memory-support.js';

describe('chat memory evidence, without launching a browser', () => {
  it('refuses at the real entry point before writing evidence or loading a browser', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'chat-memory-guard-'));
    const output = path.join(dir, 'must-not-exist');
    try {
      const error = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          path.resolve(import.meta.dirname, '../chat-memory.ts'),
          '--revision',
          'a'.repeat(40),
          '--output',
          output,
        ],
        { env: { DISPLAY: '' }, timeout: 10_000 }
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 1, stderr: expect.stringMatching(/Docker|display/) });
      expect(existsSync(output)).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it('refuses macOS, non-Docker Linux and a missing display', () => {
    expect(() => assertDocker('darwin', true, ':99')).toThrow('Docker');
    expect(() => assertDocker('linux', false, ':99')).toThrow('Docker');
    expect(() => assertDocker('linux', true, '')).toThrow('display');
    expect(() => assertDocker('linux', true, ':99')).not.toThrow();
  });

  it('requires an exact source revision and output, with bounded sampling options', () => {
    const args = ['--revision', 'a'.repeat(40), '--output', '/evidence/run'];
    expect(parseOptions(args)).toMatchObject({ chats: [1, 3, 5], repeats: 3, samples: 10 });
    expect(parseOptions([...args, '--chats', '1,3,5,6']).chats).toEqual([1, 3, 5, 6]);
    for (const extra of [
      ['--samples', '0'],
      ['--repeats', '99'],
      ['--interval-ms', 'NaN'],
      ['--chats', '1,1,5'],
      ['--chats', '5'],
      ['--unknown', 'yes'],
    ])
      expect(() => parseOptions([...args, ...extra])).toThrow();
    expect(() => parseOptions([])).toThrow();
  });

  it('parses process identity without reading or reporting command lines', () => {
    const fields = ['S', '41', ...Array<string>(17).fill('0'), '12345'];
    expect(parseProcess(`42 (chrome (worker)) ${fields.join(' ')}`)).toEqual({
      pid: 42,
      parent: 41,
      birth: '12345',
      state: 'S',
    });
    expect(() => parseProcess('42 (truncated) S')).toThrow();
  });

  it('counts only living descendants of the exact owned root, rejecting PID reuse', () => {
    const root = { pid: 10, parent: 1, birth: '100', state: 'S' };
    const child = { pid: 11, parent: 10, birth: '101', state: 'S' };
    const grandchild = { pid: 12, parent: 11, birth: '102', state: 'S' };
    const zombie = { pid: 13, parent: 10, birth: '103', state: 'Z' };
    const unrelated = { pid: 20, parent: 1, birth: '200', state: 'S' };
    const table = [root, child, grandchild, zombie, unrelated];
    expect(ownedProcesses([root], table)).toEqual([root, child, grandchild]);
    expect(() => ownedProcesses([{ ...root, birth: '99' }], table)).toThrow('root');
  });

  it('uses PSS and private bytes, keeping RSS separate rather than double-counting shared pages', () => {
    const text = 'Rss: 2048 kB\nPss: 1024 kB\nPrivate_Clean: 128 kB\nPrivate_Dirty: 256 kB\n';
    expect(parseSmaps(text)).toEqual({ rss: 2097152, pss: 1048576, private: 393216 });
    expect(() => parseSmaps('Rss: 2048 kB')).toThrow('Pss');
    expect(() => parseSmaps(text.replace('1024 kB', 'NaN kB'))).toThrow();
  });

  it('retains observed peaks and refuses empty/non-finite samples', () => {
    expect(summarize([3, 1, 2, 100])).toEqual({ min: 1, median: 2, p95: 100, max: 100 });
    expect(() => summarize([])).toThrow();
    expect(() => summarize([1, NaN])).toThrow();
  });
});
