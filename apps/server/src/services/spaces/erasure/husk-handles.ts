import { randomBytes } from 'node:crypto';
import { MENTION_ADDRESS, MENTION_TRAILING_STRIP, maskedText } from '../content/mentions.js';

/** What an erased person's handle becomes in other people's messages. It can never resolve. */
export const ERASED_MENTION = '@[erased]';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADDRESS_BOUNDARY = /[A-Za-z0-9_.-]/;

/** An unguessable replacement handle, so the husk cannot be used to find the person again. */
export function randomHuskHandle(): string {
  // 256 is a multiple of 32, so taking each byte modulo 32 is unbiased.
  return `erased-${[...randomBytes(12)].map((byte) => BASE32[byte % 32]).join('')}`;
}

/**
 * Replace every `@handle` the mention resolver would read as one of `handles` with
 * {@link ERASED_MENTION}. It masks code and quotes exactly as the resolver does, applies the
 * resolver's trailing strip (and keeps the stripped characters), and only rewrites an `@` at
 * the start of the text or after a character that cannot be part of an address, so an
 * email-shaped `bob@handle` is left alone.
 */
export function rewriteHandleTokens(text: string, handles: readonly string[]): string {
  const targets = new Set(handles.map((handle) => handle.toLowerCase()));
  if (!targets.size) return text;
  let rewritten = '';
  let copied = 0;
  for (const match of maskedText(text).matchAll(MENTION_ADDRESS)) {
    const at = match.index;
    if (at > 0 && ADDRESS_BOUNDARY.test(text[at - 1])) continue;
    const raw = match[1];
    const stripped = raw.replace(MENTION_TRAILING_STRIP, '');
    if (!targets.has(stripped.toLowerCase())) continue;
    rewritten += text.slice(copied, at) + ERASED_MENTION + raw.slice(stripped.length);
    copied = at + 1 + raw.length;
  }
  return copied ? rewritten + text.slice(copied) : text;
}
