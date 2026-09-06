import { describe, it, expect } from 'vitest';
import {
  ResetTokenStore,
  RESET_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_DESCRIPTION,
} from '../reset-token.js';

describe('ResetTokenStore', () => {
  it('accepts the token it just minted', () => {
    const store = new ResetTokenStore();
    const { token } = store.mint();
    expect(store.consume(token)).toBe(true);
  });

  it('enforces the lifetime its copy promises', () => {
    const store = new ResetTokenStore();
    const { token } = store.mint(1_000);

    expect(store.consume(token, 1_000 + RESET_TOKEN_TTL_MS - 1)).toBe(true);
  });

  // The refusal tells a person how long they have. That sentence is built from
  // the constant, so the two cannot drift apart.
  it('describes its lifetime in the words the refusal uses', () => {
    expect(RESET_TOKEN_TTL_DESCRIPTION).toBe(`${RESET_TOKEN_TTL_MS / 60_000} minutes`);
  });

  it('refuses when nothing was ever minted', () => {
    expect(new ResetTokenStore().consume('anything')).toBe(false);
  });

  it('mints a different token every time', () => {
    const store = new ResetTokenStore();
    const tokens = new Set(Array.from({ length: 50 }, () => store.mint().token));
    expect(tokens.size).toBe(50);
  });

  it('spends a token on first use', () => {
    const store = new ResetTokenStore();
    const { token } = store.mint();

    expect(store.consume(token)).toBe(true);
    expect(store.consume(token)).toBe(false);
  });

  it('expires a token that was never used', () => {
    const store = new ResetTokenStore({ ttlMs: 1_000 });
    const { token } = store.mint(0);

    expect(store.consume(token, 1_000)).toBe(false);
  });

  it('keeps only the newest token', () => {
    const store = new ResetTokenStore();
    const { token: first } = store.mint();
    const { token: second } = store.mint();

    expect(store.consume(first)).toBe(false);
    expect(store.consume(second)).toBe(true);
  });

  // A wrong guess must not disarm the real token — otherwise anything that can
  // send a request can keep an operator from ever finishing a reset.
  it('leaves the armed token alone when a guess is wrong', () => {
    const store = new ResetTokenStore();
    const { token } = store.mint();

    expect(store.consume(`${token}x`)).toBe(false);
    expect(store.consume(token)).toBe(true);
  });

  // The value arrives straight off a JSON request body, so it can be anything.
  it.each([undefined, null, 42, '', {}, [], true])('refuses %o without throwing', (presented) => {
    const store = new ResetTokenStore();
    store.mint();
    expect(store.consume(presented)).toBe(false);
  });
});
