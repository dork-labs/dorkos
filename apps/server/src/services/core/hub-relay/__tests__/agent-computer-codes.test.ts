/**
 * @vitest-environment node
 *
 * The machine link codes a hub mints for its agent computers (DOR-2940):
 * bound to one computer, one live code per computer, single use, ten minutes,
 * and kept on disk as hashes only, so they survive the hub sleeping.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  AGENT_COMPUTER_LINK_CODE_TTL_MS,
  AGENT_COMPUTER_LINK_MAX_FAILURES,
  AgentComputerCodeBook,
} from '../agent-computer-codes.js';

const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);
const clock = { now: 1_000_000 };
let home: string;
let book: AgentComputerCodeBook;

const file = () => path.join(home, 'hub-relay', 'agent-computer-codes.json');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-ac-codes-'));
  clock.now = 1_000_000;
  book = new AgentComputerCodeBook(
    () => home,
    () => clock.now
  );
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('a code', () => {
  it('is sixteen characters of Crockford base32, good for ten minutes', async () => {
    const minted = await book.mint('cmp_1');
    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(minted.expiresAt).toBe(clock.now + AGENT_COMPUTER_LINK_CODE_TTL_MS);
  });

  it('redeems once for its own computer, by the key that spends it', async () => {
    const { code } = await book.mint('cmp_1');
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'fresh' });
    // Spent: a second claim learns who spent it, so the hub can tell a retry from a theft.
    expect(await book.claim('cmp_1', code, KEY_B)).toEqual({ kind: 'spent', byKey: KEY_A });
  });

  it('is bound to its computer: another computer cannot redeem it', async () => {
    const { code } = await book.mint('cmp_1');
    expect(await book.claim('cmp_2', code, KEY_A)).toEqual({ kind: 'invalid' });
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'fresh' });
  });

  it('stops working at ten minutes', async () => {
    const { code } = await book.mint('cmp_1');
    clock.now += AGENT_COMPUTER_LINK_CODE_TTL_MS;
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'invalid' });
  });

  it('is replaced by the next code for the same computer', async () => {
    const first = await book.mint('cmp_1');
    const second = await book.mint('cmp_1');
    expect(await book.claim('cmp_1', first.code, KEY_A)).toEqual({ kind: 'invalid' });
    expect(await book.claim('cmp_1', second.code, KEY_A)).toEqual({ kind: 'fresh' });
  });

  it('leaves other computers` codes alone', async () => {
    const one = await book.mint('cmp_1');
    await book.mint('cmp_2');
    expect(await book.claim('cmp_1', one.code, KEY_A)).toEqual({ kind: 'fresh' });
  });

  it('reads as typed, with dashes and lowercase', async () => {
    const { code } = await book.mint('cmp_1');
    const typed = code.toLowerCase().match(/.{4}/g)!.join('-');
    expect(await book.claim('cmp_1', typed, KEY_A)).toEqual({ kind: 'fresh' });
  });

  it('can be forgotten', async () => {
    const { code } = await book.mint('cmp_1');
    await book.forget('cmp_1');
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'invalid' });
  });
});

describe('on disk', () => {
  it('survives the hub restarting: a new book over the same folder redeems it', async () => {
    const { code } = await book.mint('cmp_1');
    const afterRestart = new AgentComputerCodeBook(
      () => home,
      () => clock.now
    );
    expect(await afterRestart.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'fresh' });
    // And the spend survives too.
    const again = new AgentComputerCodeBook(
      () => home,
      () => clock.now
    );
    expect(await again.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'spent', byKey: KEY_A });
  });

  it('keeps only hashes, owner-only, in an owner-only folder', async () => {
    const { code } = await book.mint('cmp_1');
    const text = fs.readFileSync(file(), 'utf8');
    expect(text).not.toContain(code);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file())).mode & 0o777).toBe(0o700);
  });

  it('drops expired codes the next time it writes', async () => {
    await book.mint('cmp_1');
    clock.now += AGENT_COMPUTER_LINK_CODE_TTL_MS;
    await book.mint('cmp_2');
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8')) as { codes: unknown[] };
    expect(stored.codes).toHaveLength(1);
  });

  it('reads a damaged file as no codes, so nothing redeems', async () => {
    const { code } = await book.mint('cmp_1');
    fs.writeFileSync(file(), '{not json');
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'invalid' });
  });
});

describe('failures', () => {
  it('refuses every claim past too many wrong codes, until a code is minted', async () => {
    const { code } = await book.mint('cmp_1');
    for (let i = 0; i < AGENT_COMPUTER_LINK_MAX_FAILURES; i++) {
      await book.claim('cmp_1', '0000000000000000', KEY_A);
    }
    expect(await book.claim('cmp_1', code, KEY_A)).toEqual({ kind: 'throttled' });
    const next = await book.mint('cmp_1');
    expect(await book.claim('cmp_1', next.code, KEY_A)).toEqual({ kind: 'fresh' });
  });
});
