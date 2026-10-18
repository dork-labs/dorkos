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
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../../audit/audit-trail.js', () => ({ recordAudit: audit.record }));

import { logger } from '../../../../lib/logger.js';
import {
  HUB_RELAY_MAX_COMPUTERS,
  LinkedComputerKeyMismatchError,
  LinkedComputersUnreadableError,
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

  it('replaces a computer linked again under its id and key, and forgets one unlinked', async () => {
    const old = secret();
    const fresh = secret();
    const computerKey = key();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(old), computerKey },
      home
    );
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(fresh), computerKey },
      home
    );
    expect(readLinkedComputers(home)).toHaveLength(1);
    expect(findComputerBySecret(old, home)).toBeNull();
    expect(findComputerBySecret(fresh, home)?.computerId).toBe('computer-1');

    expect(await unlinkComputer('computer-1', home)).toBe(true);
    expect(await unlinkComputer('computer-1', home)).toBe(false);
    expect(findComputerBySecret(fresh, home)).toBeNull();
  });

  it('refuses a linked id under another key, and keeps the record it has', async () => {
    const kept = secret();
    await linkComputer(
      { computerId: 'computer-1', secretHash: relaySecretHash(kept), computerKey: key() },
      home
    );
    await expect(
      linkComputer(
        { computerId: 'computer-1', secretHash: relaySecretHash(secret()), computerKey: key() },
        home
      )
    ).rejects.toBeInstanceOf(LinkedComputerKeyMismatchError);
    expect(findComputerBySecret(kept, home)?.computerId).toBe('computer-1');
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

describe('format 2: agent computers (DOR-2940)', () => {
  it('reads a format-1 record as a person`s computer, and writes format 2 next time', async () => {
    const v1 = {
      v: 1,
      computerId: 'mac-1',
      secretHash: relaySecretHash(secret()),
      computerKey: key(),
      computerName: 'Studio Mac',
      linkedAt: '2026-10-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify([v1]));
    expect(readLinkedComputers(home)).toEqual([{ ...v1, v: 2, role: 'computer' }]);

    // Any write moves the whole file to format 2, keeping the old record.
    await linkComputer(
      { computerId: 'mac-2', secretHash: relaySecretHash(secret()), computerKey: key() },
      home
    );
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8')) as Array<Record<string, unknown>>;
    expect(stored.map((r) => [r.v, r.role, r.computerId])).toEqual([
      [2, 'computer', 'mac-1'],
      [2, 'computer', 'mac-2'],
    ]);
  });

  it('drops a format-1 record in the reserved id space, and a store keeps every other link', async () => {
    const legacy = {
      v: 1,
      computerId: 'ac:legacy',
      secretHash: relaySecretHash(secret()),
      computerKey: key(),
      linkedAt: '2026-10-01T00:00:00.000Z',
    };
    const mac = {
      v: 1,
      computerId: 'mac-1',
      secretHash: relaySecretHash(secret()),
      computerKey: key(),
      linkedAt: '2026-10-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify([legacy, mac]));
    expect(readLinkedComputers(home).map((c) => c.computerId)).toEqual(['mac-1']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropped old computer records'),
      { dropped: 1 }
    );

    await linkComputer(
      { computerId: 'mac-2', secretHash: relaySecretHash(secret()), computerKey: key() },
      home
    );
    // Written back, read again: the file still parses, and both links survive.
    const reread = readLinkedComputers(home).map((c) => c.computerId);
    expect(reread).toEqual(['mac-1', 'mac-2']);
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown[];
    expect(stored).toHaveLength(2);
  });

  it('moves a file that does not parse aside, owner-only, and links again from a fresh list', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '[{"v": 9}]');
    expect(readLinkedComputers(home)).toEqual([]);
    await linkComputer(
      { computerId: 'mac-2', secretHash: relaySecretHash(secret()), computerKey: key() },
      home
    );
    expect(readLinkedComputers(home).map((c) => c.computerId)).toEqual(['mac-2']);
    const aside = fs
      .readdirSync(path.dirname(file()))
      .filter((name) => name.startsWith('computers.json.bad-'));
    expect(aside).toHaveLength(1);
    const kept = path.join(path.dirname(file()), aside[0]!);
    expect(fs.readFileSync(kept, 'utf8')).toBe('[{"v": 9}]');
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('moved aside'),
      expect.objectContaining({ movedTo: aside[0] })
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.relay.computers.quarantined', outcome: 'failed' })
    );
  });

  it('refuses to write, rather than overwrite, a bad file it cannot move', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '[{"v": 9}]');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    try {
      await expect(unlinkComputer('mac-2', home)).rejects.toBeInstanceOf(
        LinkedComputersUnreadableError
      );
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(file(), 'utf8')).toBe('[{"v": 9}]');
  });

  it('stores an agent computer with its cloud id and role', async () => {
    const record = await linkComputer(
      {
        role: 'agent-computer',
        cloudComputerId: 'cmp_1',
        computerId: 'ac:cmp_1',
        secretHash: relaySecretHash(secret()),
        computerKey: key(),
        computerName: 'Cloud computer',
      },
      home
    );
    expect(record).toMatchObject({ v: 2, role: 'agent-computer', cloudComputerId: 'cmp_1' });
    expect(readLinkedComputers(home)).toEqual([record]);
  });

  it('refuses an agent computer whose relay id is not its cloud id', async () => {
    await expect(
      linkComputer(
        {
          role: 'agent-computer',
          cloudComputerId: 'cmp_1',
          computerId: 'ac:cmp_2',
          secretHash: relaySecretHash(secret()),
          computerKey: key(),
        },
        home
      )
    ).rejects.toThrow();
    expect(readLinkedComputers(home)).toEqual([]);
  });

  it('refuses a person`s computer in the agent computers` id space', async () => {
    await expect(
      linkComputer(
        { computerId: 'ac:cmp_1', secretHash: relaySecretHash(secret()), computerKey: key() },
        home
      )
    ).rejects.toThrow();
  });

  it('reads a file whose agent computer record is inconsistent as no computers', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify([
        {
          v: 2,
          role: 'agent-computer',
          cloudComputerId: 'cmp_1',
          computerId: 'ac:cmp_other',
          secretHash: relaySecretHash(secret()),
          computerKey: key(),
          linkedAt: '2026-10-01T00:00:00.000Z',
        },
      ])
    );
    expect(readLinkedComputers(home)).toEqual([]);
  });
});
