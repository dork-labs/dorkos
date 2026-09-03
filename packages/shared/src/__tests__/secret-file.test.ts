/**
 * Unit coverage for the first-writer-wins secret claim.
 *
 * The cross-process race it exists for is driven for real in
 * `first-boot-host-key-race.test.ts`; this file pins the branches that race
 * lands on — adopting a winner's value, and taking over a file a crashed write
 * left empty.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSecretBytes, claimSecretText } from '../secret-file.js';

const MODE = 0o600;

describe('claimSecretText', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints when the file is absent, creating parent directories', () => {
    const filePath = join(dir, 'nested', 'secret');

    const claimed = claimSecretText(filePath, 'minted-value', MODE);

    expect(claimed).toEqual({ value: 'minted-value', minted: true });
    expect(readFileSync(filePath, 'utf8')).toBe('minted-value');
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o077).toBe(0);
    }
  });

  it('adopts an existing value and leaves the file alone', () => {
    const filePath = join(dir, 'secret');
    writeFileSync(filePath, 'winner-value', { mode: MODE });

    const claimed = claimSecretText(filePath, 'loser-value', MODE);

    expect(claimed).toEqual({ value: 'winner-value', minted: false });
    expect(readFileSync(filePath, 'utf8')).toBe('winner-value');
  });

  it('writes a trimmed value, so a winner and an adopter hold the same string', () => {
    const filePath = join(dir, 'secret');

    expect(claimSecretText(filePath, ' minted-value \n', MODE).value).toBe('minted-value');
    expect(readFileSync(filePath, 'utf8')).toBe('minted-value');
  });

  it('trims the adopted value, matching how every secret is read', () => {
    const filePath = join(dir, 'secret');
    writeFileSync(filePath, '  winner-value\n', { mode: MODE });

    expect(claimSecretText(filePath, 'loser-value', MODE).value).toBe('winner-value');
  });

  // Mode bits only bite a non-root POSIX process; root reads whatever it likes.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never overwrites a secret it is not allowed to read',
    () => {
      const filePath = join(dir, 'secret');
      writeFileSync(filePath, 'someone-elses-value', { mode: MODE });
      chmodSync(filePath, 0o000);

      expect(() => claimSecretText(filePath, 'minted-value', MODE)).toThrow();

      chmodSync(filePath, MODE);
      expect(readFileSync(filePath, 'utf8')).toBe('someone-elses-value');
    }
  );

  it('refuses to persist a blank secret', () => {
    const filePath = join(dir, 'secret');

    expect(() => claimSecretText(filePath, '   ', MODE)).toThrow(/blank secret/);
  });

  it('takes over a file a crashed write left blank', () => {
    const filePath = join(dir, 'secret');
    writeFileSync(filePath, '   ', { mode: MODE });

    const claimed = claimSecretText(filePath, 'minted-value', MODE);

    expect(claimed).toEqual({ value: 'minted-value', minted: true });
    expect(readFileSync(filePath, 'utf8')).toBe('minted-value');
  });
});

describe('claimSecretBytes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints raw bytes when the file is absent', () => {
    const filePath = join(dir, 'host.key');
    const bytes = Buffer.from([0, 1, 2, 3]);

    const claimed = claimSecretBytes(filePath, bytes, MODE);

    expect(claimed.minted).toBe(true);
    expect(claimed.value.equals(bytes)).toBe(true);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
  });

  it("adopts the winner's bytes verbatim, whitespace and all", () => {
    const filePath = join(dir, 'host.key');
    const winner = Buffer.from([0x20, 0x0a, 0x09]);
    writeFileSync(filePath, winner, { mode: MODE });

    const claimed = claimSecretBytes(filePath, Buffer.from([9, 9]), MODE);

    expect(claimed.minted).toBe(false);
    expect(claimed.value.equals(winner)).toBe(true);
  });

  it('takes over a zero-length file', () => {
    const filePath = join(dir, 'host.key');
    writeFileSync(filePath, Buffer.alloc(0), { mode: MODE });
    const bytes = Buffer.from([7, 7, 7]);

    const claimed = claimSecretBytes(filePath, bytes, MODE);

    expect(claimed.minted).toBe(true);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
  });
});
