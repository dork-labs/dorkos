import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readRecoveryPassword } from '../recover-password.js';

describe('recovery password input', () => {
  it('accepts a piped line without trimming meaningful spaces', async () => {
    expect(await readRecoveryPassword(Readable.from([' a long password ', '\r\n']))).toBe(
      ' a long password '
    );
  });
  it('bounds input before accumulating an arbitrary stream', async () => {
    await expect(readRecoveryPassword(Readable.from([Buffer.alloc(1025)]))).rejects.toThrow(
      'too long'
    );
  });
});
