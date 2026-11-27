/**
 * Unit coverage for the first-writer-wins secret claim.
 *
 * The cross-process race it exists for is driven for real in
 * `first-boot-host-key-race.test.ts`; this file pins what happens around it —
 * adopting a winner's value, refusing a file that holds no usable secret rather
 * than overwriting it, and leaving no temp file behind either way.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSecretBytes,
  claimSecretText,
  publishSecretFile,
  quarantineSecretFile,
} from '../secret-file.js';

const MODE = 0o600;

/** Every entry in `dir`, temp files included — nothing here hides dotfiles. */
function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

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
    expect(entries(join(dir, 'nested'))).toEqual(['secret']);
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
    // The temp file the losing claim wrote must not survive the loss.
    expect(entries(dir)).toEqual(['secret']);
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

  it('refuses a blank file rather than overwriting it', () => {
    const filePath = join(dir, 'secret');
    writeFileSync(filePath, '   ', { mode: MODE });

    // A blank file is never something this module published — the link makes
    // the content complete before the name exists — so it is a leftover from
    // an older build or an interrupted write, and adopting or replacing it are
    // both guesses about data nobody can read.
    expect(() => claimSecretText(filePath, 'minted-value', MODE)).toThrow(/does not hold a usable/);
    expect(readFileSync(filePath, 'utf8')).toBe('   ');
    expect(entries(dir)).toEqual(['secret']);
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
    expect(entries(dir)).toEqual(['host.key']);
  });

  it("adopts the winner's bytes verbatim, whitespace and all", () => {
    const filePath = join(dir, 'host.key');
    const winner = Buffer.from([0x20, 0x0a, 0x09]);
    writeFileSync(filePath, winner, { mode: MODE });

    const claimed = claimSecretBytes(filePath, Buffer.from([9, 9, 9]), MODE);

    expect(claimed.minted).toBe(false);
    expect(claimed.value.equals(winner)).toBe(true);
  });

  it('refuses a zero-length file rather than deriving from nothing', () => {
    const filePath = join(dir, 'host.key');
    writeFileSync(filePath, Buffer.alloc(0), { mode: MODE });

    expect(() => claimSecretBytes(filePath, Buffer.from([7, 7, 7]), MODE)).toThrow(
      /expected 3 bytes, found 0/
    );
    expect(readFileSync(filePath).length).toBe(0);
  });

  it('refuses a truncated key rather than adopting a short one', () => {
    const filePath = join(dir, 'host.key');
    writeFileSync(filePath, Buffer.from([1, 2]), { mode: MODE });

    expect(() => claimSecretBytes(filePath, Buffer.from([7, 7, 7]), MODE)).toThrow(
      /expected 3 bytes, found 2/
    );
  });
});

describe('publishSecretFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers false without touching a destination that is taken', () => {
    const filePath = join(dir, 'secret');
    writeFileSync(filePath, 'first', { mode: MODE });

    expect(publishSecretFile(filePath, 'second', MODE)).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe('first');
    expect(entries(dir)).toEqual(['secret']);
  });

  it('publishes a file that is whole from the moment it exists', () => {
    const filePath = join(dir, 'secret');
    const contents = 'x'.repeat(64);

    expect(publishSecretFile(filePath, contents, MODE)).toBe(true);
    // Nothing partial can be observed: the destination is a link to a file that
    // was already fully written, so its size is final at creation.
    expect(statSync(filePath).size).toBe(contents.length);
    expect(readFileSync(filePath, 'utf8')).toBe(contents);
  });
});

describe('quarantineSecretFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves the file aside and frees the name for a fresh claim', () => {
    const filePath = join(dir, 'vapid.json');
    writeFileSync(filePath, 'not json', { mode: MODE });

    const movedTo = quarantineSecretFile(filePath);

    expect(movedTo).toMatch(/vapid\.json\.unusable-/);
    expect(readFileSync(movedTo!, 'utf8')).toBe('not json');
    expect(claimSecretText(filePath, 'fresh-value', MODE)).toEqual({
      value: 'fresh-value',
      minted: true,
    });
  });

  it('answers null when another process already moved it', () => {
    expect(quarantineSecretFile(join(dir, 'missing'))).toBeNull();
  });

  it('moves whatever is at the path, which may not be what the caller judged', () => {
    const filePath = join(dir, 'vapid.json');
    writeFileSync(filePath, 'not json', { mode: MODE });
    // A caller decides the file is junk, and another process replaces it with a
    // good value before the rename lands. The rename is atomic, so the moved
    // file is definitively this caller's to inspect — but it is NOT the file it
    // judged, which is why callers must parse what they moved before replacing
    // it (`readOrCreateVapidKeys` restores it instead).
    writeFileSync(filePath, 'perfectly-good-value', { mode: MODE });

    const movedTo = quarantineSecretFile(filePath);

    expect(readFileSync(movedTo!, 'utf8')).toBe('perfectly-good-value');
  });
});
