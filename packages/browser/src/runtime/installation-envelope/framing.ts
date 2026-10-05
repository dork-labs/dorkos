import { EnvelopeError } from './scanner.js';

/** Locate the exact bounded top-level reply bytes, skipping nested strings and containers. */
export function replySpan(bytes: Uint8Array, check: () => void): Uint8Array {
  let depth = 0;
  let at = 0;
  const skipString = () => {
    at++;
    while (at < bytes.length) {
      check();
      const c = bytes[at++];
      if (c === 92) at++;
      else if (c === 34) return;
    }
    throw new EnvelopeError('VERIFIER_REPLY_INVALID');
  };
  const white = () => {
    while ([32, 9, 10, 13].includes(bytes[at] ?? -1)) {
      check();
      at++;
    }
  };
  while (at < bytes.length) {
    check();
    const c = bytes[at];
    if (c === 34) {
      const start = at;
      skipString();
      const end = at;
      white();
      if (depth === 1 && bytes[at] === 58) {
        const key = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end))
        ) as string;
        check();
        if (key === 'verifierReply') {
          at++;
          white();
          const begin = at;
          let level = 0;
          do {
            check();
            const char = bytes[at];
            if (char === 34) skipString();
            else {
              at++;
              if (char === 123 || char === 91) level++;
              else if (char === 125 || char === 93) level--;
            }
          } while (level > 0 && at < bytes.length);
          return bytes.subarray(begin, at);
        }
      }
    } else {
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) depth--;
      at++;
    }
  }
  throw new EnvelopeError('VERIFIER_REPLY_INVALID');
}
