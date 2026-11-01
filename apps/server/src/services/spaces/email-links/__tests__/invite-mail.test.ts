import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { existingAccountMail, finishJoiningMail, spaceNameFor } from '../invite-mail.js';

const pool = (rows: { name: string }[]) =>
  ({ query: vi.fn(async () => ({ rows })) }) as unknown as Pool;

describe('the mail an invitation sign-up sends (DOR-2730)', () => {
  it("names the space by its record's name", async () => {
    expect(await spaceNameFor(pool([{ name: 'Night shift' }]), 'c1', 'https://x.test')).toBe(
      'Night shift'
    );
  });

  it('falls back to the bare hostname of the configured public URL, never a port', async () => {
    // Fails if a mail names a space by a raw URL or `host:port`.
    expect(await spaceNameFor(pool([]), null, 'http://localhost:6481')).toBe('localhost');
    expect(await spaceNameFor(pool([]), 'gone', 'https://space.dorkos.ai')).toBe('space.dorkos.ai');
  });

  it('carries the link only in the finishing mail, and none in the notice', () => {
    const finish = finishJoiningMail('Night shift', 'https://x.test/reset-password#token');
    const notice = existingAccountMail('Night shift', 'https://x.test/');
    expect(finish.subject).toBe('Finish joining Night shift');
    expect(notice.subject).toBe('Sign in to Night shift');
    expect(JSON.stringify(notice)).not.toContain('#');
  });
});
