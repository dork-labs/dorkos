import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip } from '../zip-writer';
import { readZip } from './zip-reader';

/** A fixed moment, so the DOS date/time fields are assertable. */
const MODIFIED_AT = new Date(2026, 7, 24, 13, 45, 31);

describe('buildZip', () => {
  it('round-trips every entry byte-for-byte, through the central directory', () => {
    const archive = buildZip(
      [
        { name: 'report.txt', data: Buffer.from('DorkOS diagnostic report\n', 'utf8') },
        { name: 'update/listings.txt', data: Buffer.from('nothing here\n', 'utf8') },
      ],
      MODIFIED_AT
    );

    const files = readZip(archive);
    expect([...files.keys()]).toEqual(['report.txt', 'update/listings.txt']);
    expect(files.get('report.txt')!.toString('utf8')).toBe('DorkOS diagnostic report\n');
    expect(files.get('update/listings.txt')!.toString('utf8')).toBe('nothing here\n');
  });

  it('stores arbitrary binary bytes without mangling them', () => {
    // A plist and a rotated log are not text; a writer that round-trips only
    // ASCII would pass every other test here.
    const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x62, 0x70, 0x6c, 0x69, 0x73, 0x74]);

    const files = readZip(buildZip([{ name: 'ShipItState.plist', data: binary }], MODIFIED_AT));

    expect(files.get('ShipItState.plist')!.equals(binary)).toBe(true);
  });

  it('handles a non-ASCII entry name', () => {
    const files = readZip(buildZip([{ name: 'rapport-café.txt', data: Buffer.from('ok') }]));

    expect([...files.keys()]).toEqual(['rapport-café.txt']);
  });

  it('writes an empty but valid archive for no entries', () => {
    const archive = buildZip([], MODIFIED_AT);

    expect(archive).toHaveLength(22);
    expect(readZip(archive).size).toBe(0);
  });

  it('stores an empty file rather than dropping it', () => {
    const files = readZip(buildZip([{ name: 'empty.log', data: Buffer.alloc(0) }], MODIFIED_AT));

    expect(files.has('empty.log')).toBe(true);
    expect(files.get('empty.log')).toHaveLength(0);
  });

  it('records the CRC of the data, matched between local and central headers', () => {
    // The central directory is written from the same computation as the local
    // header but into a separate record; extractors verify against the local
    // one and index by the central one, so a disagreement is a corrupt archive.
    const archive = buildZip([{ name: 'a.txt', data: Buffer.from('DorkOS') }], MODIFIED_AT);
    const localCrc = archive.readUInt32LE(14);
    const centralCrc = archive.readUInt32LE(archive.length - 22 - 46 - 'a.txt'.length + 16);

    // CRC-32 of "DorkOS", from the IEEE 802.3 polynomial.
    expect(localCrc).toBe(0x3e5e1617);
    expect(centralCrc).toBe(localCrc);
  });

  it('stamps the DOS date and time fields from the supplied moment', () => {
    const archive = buildZip([{ name: 'a.txt', data: Buffer.from('x') }], MODIFIED_AT);

    // 2026-08-24 -> ((2026-1980) << 9) | (8 << 5) | 24; 13:45:31 -> two-second
    // resolution truncates the seconds to 15.
    expect(archive.readUInt16LE(12)).toBe((46 << 9) | (8 << 5) | 24);
    expect(archive.readUInt16LE(10)).toBe((13 << 11) | (45 << 5) | 15);
  });

  it('clamps a clock outside the range DOS dates can express, at both ends', () => {
    // Overflowing the 7-bit year field takes the month and day bits with it
    // and makes the whole archive unreadable — and a machine with a badly
    // wrong clock is exactly the kind that needs to file a report.
    const tooEarly = buildZip([{ name: 'a', data: Buffer.from('x') }], new Date(1970, 0, 5));
    const tooLate = buildZip([{ name: 'a', data: Buffer.from('x') }], new Date(2200, 0, 5));

    expect(tooEarly.readUInt16LE(12)).toBe((0 << 9) | (1 << 5) | 5);
    expect(tooLate.readUInt16LE(12)).toBe((127 << 9) | (1 << 5) | 5);
    // Still a valid archive at both extremes, not just a plausible number.
    expect(readZip(tooEarly).get('a')!.toString()).toBe('x');
    expect(readZip(tooLate).get('a')!.toString()).toBe('x');
  });

  it('refuses to emit an archive it cannot address, rather than a truncated one', () => {
    const entries = Array.from({ length: 70_000 }, (_unused, index) => ({
      name: `f${index}`,
      data: Buffer.alloc(0),
    }));

    expect(() => buildZip(entries)).toThrow(/more than 65535 entries/);
  });

  it('produces an archive that the system `unzip` accepts', () => {
    // The tests above read the archive with this repo's own reader, which can
    // only ever prove self-consistency. `unzip` is a third party with no stake
    // in our reading of the spec — the check that would catch a format
    // misunderstanding shared by writer and reader alike. It is present on
    // macOS, on the Linux CI image, and in the CLI's Docker smoke image; a
    // machine without it fails here by name rather than silently skipping.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-zip-writer-'));
    const archivePath = path.join(dir, 'archive.zip');
    try {
      fs.writeFileSync(
        archivePath,
        buildZip(
          [
            { name: 'report.txt', data: Buffer.from('DorkOS diagnostic report\n') },
            { name: 'update/listings.txt', data: Buffer.from('nothing here\n') },
          ],
          MODIFIED_AT
        )
      );

      // `-t` verifies every entry's CRC against its stored bytes.
      expect(execFileSync('unzip', ['-t', archivePath], { encoding: 'utf8' })).toContain('No errors detected'); // prettier-ignore
      expect(execFileSync('unzip', ['-p', archivePath, 'report.txt'], { encoding: 'utf8' })).toBe('DorkOS diagnostic report\n'); // prettier-ignore
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
