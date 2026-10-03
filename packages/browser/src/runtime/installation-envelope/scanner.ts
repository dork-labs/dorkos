/** Fixed-code failure; no input or diagnostic echo is retained. */
export class EnvelopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EnvelopeError';
  }
}
/** Read only a closed own-data failure code; hostile error reflection selects the fallback. */
export function intakeFailureCause(
  error: unknown
): 'BUDGET_EXCEEDED' | 'ATTEMPT_INTERRUPTED' | null {
  try {
    if (!(error instanceof EnvelopeError)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !('value' in descriptor)) return null;
    const value: unknown = descriptor.value;
    return value === 'BUDGET_EXCEEDED' || value === 'ATTEMPT_INTERRUPTED' ? value : null;
  } catch {
    // No error from an external prototype/descriptor trap is inspected recursively.
    return null;
  }
}
const reject = (): never => {
  throw new EnvelopeError('INVALID_ENVELOPE');
};
/** UTF-8 byte count without allocating an encoded copy. Rejects lone surrogates. */
export function textBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject();
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) reject();
    else bytes += 3;
  }
  return bytes;
}
interface Frame {
  start: number;
  object: boolean;
  state: 'first' | 'key' | 'colon' | 'value' | 'after';
  path: boolean;
}
/** Bounded iterative scanner. Prior keys are compared by bounded rescans, not a retained token tree. */
export function scanJSON(text: string, memberCap: number, check: () => void): void {
  let at = 0;
  let members = 0;
  let rootDone = false;
  const frames: Frame[] = [];
  const white = () => {
    while (/[\t\r\n ]/.test(text[at] ?? '\0')) {
      check();
      at++;
    }
  };
  const string = (from: number, limit: number): { end: number; value: string } => {
    let pos = from + 1;
    let value = '';
    while (pos < text.length) {
      check();
      let c = text[pos++];
      if (c === '"') {
        if (textBytes(value) > limit) reject();
        return { end: pos, value };
      }
      if (c === undefined || c.charCodeAt(0) < 32) reject();
      if (c === '\\') {
        const escape = text[pos++];
        if (escape === 'u') {
          const hex = text.slice(pos, pos + 4);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) reject();
          c = String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else {
          const codes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          c = codes[escape ?? ''];
          if (c === undefined) reject();
        }
      }
      value += c;
      // UTF-16 length bounds scratch before the final UTF-8 check.
      if (value.length > limit) reject();
    }
    return reject();
  };
  const duplicate = (frame: Frame, key: string, end: number) => {
    let depth = 0;
    let pos = frame.start + 1;
    while (pos < end) {
      check();
      const c = text[pos];
      if (c === '"') {
        const token = string(pos, 1024);
        let next = token.end;
        while (/[\t\r\n ]/.test(text[next] ?? '\0')) next++;
        if (depth === 0 && text[next] === ':' && token.value === key) reject();
        pos = token.end;
      } else {
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') depth--;
        pos++;
      }
    }
  };
  const complete = () => {
    const parent = frames.at(-1);
    if (parent) parent.state = 'after';
    else rootDone = true;
  };
  const value = (path: boolean) => {
    check();
    const c = text[at];
    if (c === '{' || c === '[') {
      if (frames.length >= 16) reject();
      frames.push({ start: at++, object: c === '{', state: 'first', path: false });
      return;
    }
    if (c === '"') at = string(at, path ? 1024 : 512).end;
    else if (text.startsWith('true', at)) at += 4;
    else if (text.startsWith('false', at)) at += 5;
    else if (text.startsWith('null', at)) at += 4;
    else {
      const start = at;
      if (text[at] === '-') at++;
      if (text[at] === '0') at++;
      else {
        if (!/[1-9]/.test(text[at] ?? '')) reject();
        while (/[0-9]/.test(text[at] ?? '')) at++;
      }
      if (text[at] === '.') {
        at++;
        const digits = at;
        while (/[0-9]/.test(text[at] ?? '')) at++;
        if (digits === at) reject();
      }
      if (text[at] === 'e' || text[at] === 'E') {
        at++;
        if (text[at] === '+' || text[at] === '-') at++;
        const digits = at;
        while (/[0-9]/.test(text[at] ?? '')) at++;
        if (digits === at) reject();
      }
      if (at - start > 64 || !Number.isFinite(Number(text.slice(start, at)))) reject();
    }
    complete();
  };
  while (true) {
    check();
    white();
    const f = frames.at(-1);
    if (!f) {
      if (rootDone) {
        if (at !== text.length) reject();
        return;
      }
      value(false);
      continue;
    }
    const close = f.object ? '}' : ']';
    if (f.state === 'first' && text[at] === close) {
      at++;
      frames.pop();
      complete();
      continue;
    }
    if (f.state === 'first') f.state = f.object ? 'key' : 'value';
    if (f.state === 'key') {
      if (text[at] !== '"') reject();
      const start = at;
      const token = string(at, 512);
      duplicate(f, token.value, start);
      f.path = token.value === 'candidateRelativeExecutablePath';
      at = token.end;
      f.state = 'colon';
      if (++members > memberCap) reject();
      continue;
    }
    if (f.state === 'colon') {
      if (text[at++] !== ':') reject();
      f.state = 'value';
      continue;
    }
    if (f.state === 'value') {
      if (!f.object && ++members > memberCap) reject();
      value(f.path);
      continue;
    }
    if (f.state === 'after') {
      if (text[at] === close) {
        at++;
        frames.pop();
        complete();
        continue;
      }
      if (text[at++] !== ',') reject();
      f.state = f.object ? 'key' : 'value';
    }
  }
}
/** Decode only after the caller has reserved the complete representation phase. */
export function decodeJSON(bytes: Uint8Array, members: number, check: () => void): unknown {
  check();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return reject();
  }
  check();
  scanJSON(text, members, check);
  check();
  const parsed: unknown = JSON.parse(text);
  check();
  return parsed;
}
