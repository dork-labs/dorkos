import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  main,
  NOTHING_TO_STAMP_EXIT,
  readNotes,
  stampReleaseNotes,
} from '../stamp-release-notes.ts';

const REAL = path.resolve(
  import.meta.dirname,
  '../../../apps/server/src/services/runtimes/shared/awareness/agent-release-notes.ts'
);

/** A notes file with one note per `[name, version]`. */
function file(...notes: [string, string][]): string {
  const body = notes
    .map(
      ([name, version]) => `  {
    version: '${version}',
    name: '${name}',
    can: 'do a thing { with braces } and a \\'quote\\'.',
    covers: ['a.b'],
    areas: [],
    gate: 'always on',
  },`
    )
    .join('\n');
  return `// header\nexport const AGENT_RELEASE_NOTES: readonly AgentReleaseNote[] = [\n${body}\n];\n\nexport function after() {}\n`;
}

describe('stampReleaseNotes', () => {
  it('stamps only the notes that were next at the release point', () => {
    const released = file(['Old', '0.140.0'], ['Shipped', 'next'], ['Removed later', 'next']);
    const main = file(['Old', '0.140.0'], ['Shipped', 'next'], ['Added after the cut', 'next']);
    const result = stampReleaseNotes(released, main, '0.142.0');
    expect(result.stamped).toEqual(['Shipped']);
    expect(result.gone).toEqual(['Removed later']);
    expect(readNotes(result.text).map((n) => [n.name, n.version])).toEqual([
      ['Old', '0.140.0'],
      ['Shipped', '0.142.0'],
      ['Added after the cut', 'next'],
    ]);
    expect(result.text.replace("'0.142.0'", "'next'")).toBe(main);
  });

  it.each([
    ['no array', 'export const OTHER = [];', /no AGENT_RELEASE_NOTES/],
    [
      'two names',
      file(['A', 'next']).replace("name: 'A',", "name: 'A',\n    name: 'B',"),
      /one single-quoted/,
    ],
    [
      'a double-quoted name',
      file(['A', 'next']).replace("name: 'A',", 'name: "A",'),
      /one single-quoted/,
    ],
    ['a bad version', file(['A', 'soon']), /not 'next' or X.Y.Z/],
    ['a repeated name', file(['A', 'next'], ['A', '0.1.0']), /Two release notes/],
    ['a spread', file(['A', 'next']).replace('\n];', '\n  ...MORE,\n];'), /only \{ … \} notes/],
  ])('refuses a file with %s', (_label, text, message) => {
    expect(() => stampReleaseNotes(text, text, '0.142.0')).toThrow(message);
  });

  it('reads the real notes file', () => {
    expect(readNotes(readFileSync(REAL, 'utf8')).length).toBeGreaterThan(0);
  });
});

describe('the CLI', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (released: string, current: string, version = '0.142.0') => {
    dir = mkdtempSync(path.join(tmpdir(), 'stamp-notes-'));
    writeFileSync(path.join(dir, 'released.ts'), released);
    writeFileSync(path.join(dir, 'notes.ts'), current);
    const args = ['--version', version, '--released', path.join(dir, 'released.ts')];
    const code = main([...args, '--file', path.join(dir, 'notes.ts')]);
    return { code, text: readFileSync(path.join(dir, 'notes.ts'), 'utf8') };
  };

  it('exits 0 and rewrites the file, 3 when nothing was next, 1 on a refusal, 2 on bad input', () => {
    expect(run(file(['A', 'next']), file(['A', 'next']))).toMatchObject({ code: 0 });
    expect(run(file(['A', 'next']), file(['A', 'next'])).text).toContain("'0.142.0'");
    expect(run(file(['A', '0.1.0']), file(['A', '0.1.0'])).code).toBe(NOTHING_TO_STAMP_EXIT);
    expect(run(file(['A', 'soon']), file(['A', 'next'])).code).toBe(1);
    expect(run(file(['A', 'next']), file(['A', 'next']), 'v1').code).toBe(1);
    expect(main(['--version', '0.142.0'])).toBe(2);
  });
});
