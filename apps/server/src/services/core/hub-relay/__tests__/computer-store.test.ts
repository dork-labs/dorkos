/**
 * @vitest-environment node
 *
 * What a hub keeps about the computers it serves: an owner-only file of ids,
 * secret hashes and pinned keys, never a secret itself.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A spy over the real compare, to see that the lookup uses it for every record.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, default: real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../../lib/logger.js';
import {
  HUB_RELAY_MAX_COMPUTERS,
  findComputerBySecret,
  readLinkedComputers,
  relaySecretHash,
  storeLinkedComputer,
  unlinkComputer,
  type LinkComputerInput,
} from '../computer-store.js';

const linkComputer = async (input: LinkComputerInput, dorkHome: string) =>
  (await storeLinkedComputer(input, dorkHome)).record;

let home: string;
const file = () => path.join(home, 'hub-relay', 'computers.json');
const secret = () => randomBytes(32).toString('base64url');
const key = () => randomBytes(32).toString('base64url');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-relay-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the linked computer store', () => {
  it('is empty until a computer is linked', () => {
    expect(readLinkedComputers(home)).toEqual([]);
    expect(findComputerBySecret(secret(), home)).toBeNull();
  });

  it('round-trips in an owner-only file that never holds the secret', async () => {
    const s = secret();
    const record = await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(s), computerKey: key() },
      home
    );
    expect(readLinkedComputers(home)).toEqual([record]);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file())).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file(), 'utf8')).not.toContain(s);
  });

  it('finds a computer by its secret, and nothing by any other', async () => {
    const one = secret();
    const two = secret();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(one), computerKey: key() },
      home
    );
    await linkComputer(
      { computerId: 'computer-2', secretHash: relaySecretHash(two), computerKey: key() },
      home
    );
    expect(findComputerBySecret(one, home)?.computerId).toBe('computer-1');
    expect(findComputerBySecret(two, home)?.computerId).toBe('computer-2');
    expect(findComputerBySecret(secret(), home)).toBeNull();
    // A stored hash is not a secret: presenting it opens nothing.
    expect(findComputerBySecret(relaySecretHash(one), home)).toBeNull();
  });

  it('compares in constant time, against every computer, whichever matches', async () => {
    const first = secret();
    for (const [i, s] of [first, secret(), secret()].entries()) {
      await linkComputer(
        { computerId: `computer-${i}`, secretHash: relaySecretHash(s), computerKey: key() },
        home
      );
    }
    vi.mocked(timingSafeEqual).mockClear();
    expect(findComputerBySecret(first, home)?.computerId).toBe('computer-0');
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  });

  it('replaces a computer linked again under its id, and forgets one unlinked', async () => {
    const old = secret();
    const fresh = secret();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(old), computerKey: key() },
      home
    );
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(fresh), computerKey: key() },
      home
    );
    expect(readLinkedComputers(home)).toHaveLength(1);
    expect(findComputerBySecret(old, home)).toBeNull();
    expect(findComputerBySecret(fresh, home)?.computerId).toBe('computer-1');

    expect(await unlinkComputer('computer-1', home)).toBe(true);
    expect(await unlinkComputer('computer-1', home)).toBe(false);
    expect(findComputerBySecret(fresh, home)).toBeNull();
  });

  it('refuses a secret another computer has, and one computer past the cap', async () => {
    const shared = relaySecretHash(secret());
    await linkComputer({ computerId: 'a', secretHash: shared, computerKey: key() }, home);
    await expect(
      linkComputer({ computerId: 'b', secretHash: shared, computerKey: key() }, home)
    ).rejects.toThrow();

    for (let i = 1; i < HUB_RELAY_MAX_COMPUTERS; i++) {
      await linkComputer(
        { computerId: `c${i}`, secretHash: relaySecretHash(secret()), computerKey: key() },
        home
      );
    }
    await expect(
      linkComputer(
        { computerId: 'one-too-many', secretHash: relaySecretHash(secret()), computerKey: key() },
        home
      )
    ).rejects.toThrow();
    expect(readLinkedComputers(home)).toHaveLength(HUB_RELAY_MAX_COMPUTERS);
  });

  it('refuses a malformed record', async () => {
    await expect(
      linkComputer(
        { computerId: 'a/b', secretHash: relaySecretHash(secret()), computerKey: key() },
        home
      )
    ).rejects.toThrow();
    await expect(
      linkComputer({ computerId: 'a', secretHash: 'short', computerKey: key() }, home)
    ).rejects.toThrow();
  });

  it('says whether a link replaced a record', async () => {
    const input = { computerId: 'c', secretHash: relaySecretHash(secret()), computerKey: key() };
    expect((await storeLinkedComputer(input, home)).replaced).toBe(false);
    const again = { ...input, secretHash: relaySecretHash(secret()) };
    expect((await storeLinkedComputer(again, home)).replaced).toBe(true);
  });

  it('reads the file once, until it changes on disk or is written', async () => {
    const s = secret();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(s), computerKey: key() },
      home
    );
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      readLinkedComputers(home);
      findComputerBySecret(s, home);
      findComputerBySecret(s, home);
      expect(reads).toHaveBeenCalledTimes(1);

      // Another writer replaces the file: the next read sees it.
      const later = new Date(Date.now() + 5_000);
      fs.writeFileSync(file(), '[]');
      fs.utimesSync(file(), later, later);
      expect(findComputerBySecret(s, home)).toBeNull();
      expect(reads).toHaveBeenCalledTimes(2);

      await linkComputer(
        { computerId: 'computer-2', secretHash: relaySecretHash(s), computerKey: key() },
        home
      );
      expect(findComputerBySecret(s, home)?.computerId).toBe('computer-2');
    } finally {
      reads.mockRestore();
    }
  });

  it('names the part that failed, never a value', async () => {
    const hash = relaySecretHash(secret());
    await linkComputer({ computerId: 'computer-1', secretHash: hash, computerKey: key() }, home);
    const good = JSON.parse(fs.readFileSync(file(), 'utf8'));
    fs.writeFileSync(file(), JSON.stringify([...good, { ...good[0], secretHash: 'bad' }]));
    vi.mocked(logger.warn).mockClear();
    readLinkedComputers(home);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      failed: 'computer 1 (secretHash)',
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(hash);

    const many = Array.from({ length: HUB_RELAY_MAX_COMPUTERS + 1 }, () => good[0]);
    fs.writeFileSync(file(), JSON.stringify(many));
    readLinkedComputers(home);
    expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), {
      failed: 'too many computers',
    });
  });

  it.each([
    ['not json', '{'],
    ['the wrong shape', JSON.stringify({ computers: [] })],
    ['an extra field', JSON.stringify([{ v: 1, computerId: 'a', secretHash: 'x', extra: 1 }])],
  ])('reads a file with %s as no computers', async (_label, text) => {
    const s = secret();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(s), computerKey: key() },
      home
    );
    fs.writeFileSync(file(), text);
    expect(readLinkedComputers(home)).toEqual([]);
    expect(findComputerBySecret(s, home)).toBeNull();
  });
});
