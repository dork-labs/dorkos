import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZipEntryInput } from '../zip64-writer.js';
import { bufferReader, FIXED_TIME, readWithYauzl, writeArchive } from './archive-test-helpers.js';

/**
 * AC-2: the archive every common unzip tool must open. A tool that is not installed is skipped
 * with the reason logged; `ditto` exists only on macOS.
 */
function available(tool: string): boolean {
  const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status === 0;
  if (!found)
    console.warn(`[zip-cross-tools] skipping ${tool}: it is not installed on this machine`);
  return found;
}

const tools = {
  unzip: available('unzip'),
  bsdtar: available('bsdtar'),
  python3: available('python3'),
  ditto: process.platform === 'darwin' && available('ditto'),
};
if (process.platform !== 'darwin') {
  console.warn('[zip-cross-tools] skipping ditto: it exists only on macOS');
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr}${result.stdout}`
    );
  }
  return result.stdout;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Name to SHA-256 of every extracted file (digests keep large comparisons fast). */
async function filesUnder(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(directory, path).normalize('NFC')] = sha256(await readFile(path));
  }
  return files;
}

function segment(index: number, file: Buffer): ZipEntryInput[] {
  const rows = Array.from({ length: 2000 }, (_, row) =>
    JSON.stringify({ index, row, body: 'hé llo' })
  ).join('\n');
  return [
    { name: `entries/00000${index}.ndjson`, method: 'deflated', source: Buffer.from(rows + '\n') },
    {
      name: `attachments/00000${index}.ndjson`,
      method: 'deflated',
      source: Buffer.from(`{"id":"f${index}"}\n`),
    },
    {
      name: `files/f${index}/Résumé ${index} (final).pdf`,
      method: 'stored',
      source: file,
      size: file.length,
    },
  ];
}

for (const forceZip64 of [false, true]) {
  describe(`external tools read a three-segment archive${forceZip64 ? ' (forced ZIP64)' : ''}`, () => {
    let directory: string;
    let path: string;
    const expected = new Map<string, Buffer>();
    let digests: Record<string, string>;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'zip-cross-tools-'));
      const files = [randomBytes(200_000), randomBytes(1), randomBytes(3_000_000)];
      const groups = files.map((file, index) => segment(index + 1, file));
      const tail: ZipEntryInput[] = [
        { name: 'members.ndjson', method: 'deflated', source: Buffer.from('{"id":"m1"}\n') },
        { name: 'community/icon', method: 'stored', source: files[1], size: 1 },
        { name: 'manifest.json', method: 'deflated', source: Buffer.from('{"version":2}') },
      ];
      for (const entry of [...groups.flat(), ...tail]) {
        const source = entry.source as Buffer;
        expected.set(entry.name, source);
      }
      digests = Object.fromEntries([...expected].map(([name, bytes]) => [name, sha256(bytes)]));
      const written = await writeArchive(groups, tail, { modifiedAt: FIXED_TIME, forceZip64 });
      expect(written.segments).toHaveLength(3);
      path = join(directory, 'export.zip');
      await writeFile(path, written.archive);
      // yauzl is always present (a dev dependency), so this leg never skips.
      const read = await readWithYauzl(bufferReader(written.archive));
      expect(
        Object.fromEntries([...read.contents].map(([name, bytes]) => [name, sha256(bytes)]))
      ).toEqual(digests);
    });

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it.skipIf(!tools.unzip)('Info-ZIP unzip tests and extracts every entry', async () => {
      expect(run('unzip', ['-t', path])).toContain('No errors detected');
      const out = join(directory, 'unzip');
      run('unzip', ['-q', '-o', path, '-d', out]);
      expect(await filesUnder(out)).toEqual(digests);
    });

    it.skipIf(!tools.bsdtar)('bsdtar lists and extracts every entry', async () => {
      expect(
        run('bsdtar', ['-tf', path])
          .trim()
          .split('\n')
          .map((name) => name.normalize('NFC'))
      ).toEqual([...expected.keys()]);
      const out = join(directory, 'bsdtar');
      run('sh', ['-c', `mkdir -p "$1" && bsdtar -xf "$2" -C "$1"`, 'sh', out, path]);
      expect(await filesUnder(out)).toEqual(digests);
    });

    it.skipIf(!tools.python3)("Python's zipfile passes testzip() and reads every entry", () => {
      const script = [
        'import hashlib, json, sys, zipfile',
        'z = zipfile.ZipFile(sys.argv[1])',
        'print(json.dumps({"testzip": z.testzip(), "files": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}}))',
      ].join('\n');
      const result = JSON.parse(run('python3', ['-c', script, path])) as {
        testzip: string | null;
        files: Record<string, string>;
      };
      expect(result.testzip).toBeNull();
      expect(result.files).toEqual(digests);
    });

    it.skipIf(!tools.ditto)('macOS ditto extracts every entry', async () => {
      const out = join(directory, 'ditto');
      run('ditto', ['-x', '-k', path, out]);
      expect(await filesUnder(out)).toEqual(digests);
    });
  });
}
