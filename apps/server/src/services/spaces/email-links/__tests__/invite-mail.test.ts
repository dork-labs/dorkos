import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { existingAccountMail, finishJoiningMail, spaceNameFor } from '../invite-mail.js';

const pool = (rows: { name: string }[]) =>
  ({ query: vi.fn(async () => ({ rows })) }) as unknown as Pool;
const NAMED = { space: 'Night shift', host: 'space.example' };
const BARE = { space: 'space.example', host: null };

describe('the mail an invitation sign-up sends (DOR-2730)', () => {
  it("names the space by its record's name, with the bare hostname it lives on", async () => {
    expect(
      await spaceNameFor(pool([{ name: 'Night shift' }]), 'c1', 'https://x.test:8443')
    ).toEqual({ space: 'Night shift', host: 'x.test' });
  });

  it('falls back to the bare hostname alone, never a port, with no name to give', async () => {
    // Fails if a mail names a space by a raw URL or `host:port`.
    expect(await spaceNameFor(pool([]), null, 'http://localhost:6481')).toEqual({
      space: 'localhost',
      host: null,
    });
    expect(await spaceNameFor(pool([{ name: '‮​ ' }]), 'c1', 'https://s.io')).toEqual({
      space: 's.io',
      host: null,
    });
  });

  it('quotes the space with its host in the bodies, and keeps the subjects plain', () => {
    const finish = finishJoiningMail(NAMED, 'https://x.test/reset-password#token');
    expect(finish.subject).toBe('Finish joining Night shift');
    expect(finish.text).toContain(
      'Set a password to finish joining “Night shift” on space.example.'
    );
    const notice = existingAccountMail(NAMED, 'https://x.test/');
    expect(notice.subject).toBe('Sign in to Night shift');
    expect(notice.text).toContain(
      'Someone tried to join “Night shift” on space.example with this address, and you already have an account.'
    );
    expect(JSON.stringify(notice)).not.toContain('#');
  });

  it('says the host once when it stands in for the name', () => {
    // Fails if a fallback body reads "… space.example on space.example".
    expect(finishJoiningMail(BARE, 'https://x/').text).toContain(
      'Set a password to finish joining space.example.'
    );
    expect(existingAccountMail(BARE, 'https://x/').text).toContain(
      'Someone tried to join space.example with this address'
    );
  });
});
