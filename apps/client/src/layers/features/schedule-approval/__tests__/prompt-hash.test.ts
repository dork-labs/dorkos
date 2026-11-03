/**
 * The card's prompt hash is the server's `bodyHash`, byte for byte (DOR-3703, M4):
 * the SHA-256 test vector for "abc", base64url, behind `sha256:`.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { promptHash } from '../lib/prompt-hash';

describe('promptHash', () => {
  it('matches the server’s file hash for the same text', async () => {
    expect(await promptHash('abc')).toBe('sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});
