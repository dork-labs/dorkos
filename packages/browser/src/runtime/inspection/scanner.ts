import { InspectionFailure, LIMITS } from './records.js';

/** Strict bounded UTF-8 intake and iterative JSON grammar/decoded-key census before parsing. */
export function scanJSON(bytes: Uint8Array): unknown {
  if (bytes.byteLength > LIMITS.manifest) throw new InspectionFailure('unverified');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InspectionFailure('invalid');
  }
  type Frame = {
    kind: 'object' | 'array';
    state: 'key' | 'colon' | 'value' | 'comma';
    keys: Set<string>;
    empty: boolean;
  };
  const stack: Frame[] = [];
  let i = 0,
    members = 0,
    root = false;
  const bad = (): never => {
    throw new InspectionFailure('invalid');
  };
  const ws = () => {
    while (/[\t\n\r ]/.test(text[i] ?? '!')) i++;
  };
  const string = (): string => {
    const start = i++;
    let escape = false;
    while (i < text.length) {
      const c = text[i++]!;
      if (!escape && c === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return bad();
        }
      }
      if (!escape && c.charCodeAt(0) < 32) bad();
      if (!escape && c === '\\') escape = true;
      else escape = false;
    }
    return bad();
  };
  const value = () => {
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      stack.push({
        kind: c === '{' ? 'object' : 'array',
        state: c === '{' ? 'key' : 'value',
        keys: new Set(),
        empty: true,
      });
      if (stack.length > LIMITS.depth) bad();
    } else if (c === '"') string();
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i)
      );
      if (!match) bad();
      i += match![0].length;
    }
  };
  while (true) {
    ws();
    const f = stack.at(-1);
    if (!f) {
      if (root) {
        if (i !== text.length) bad();
        break;
      }
      root = true;
      value();
      continue;
    }
    const end = f.kind === 'object' ? '}' : ']';
    if (
      ((f.empty && (f.state === 'key' || f.state === 'value')) || f.state === 'comma') &&
      text[i] === end
    ) {
      i++;
      stack.pop();
      continue;
    }
    if (f.state === 'key') {
      if (text[i] !== '"') bad();
      const key = string();
      if (f.keys.has(key)) bad();
      f.keys.add(key);
      if (++members > 256) bad();
      f.empty = false;
      f.state = 'colon';
    } else if (f.state === 'colon') {
      if (text[i++] !== ':') bad();
      f.state = 'value';
    } else if (f.state === 'value') {
      if (f.kind === 'array' && ++members > 256) bad();
      f.empty = false;
      f.state = 'comma';
      value();
    } else {
      if (text[i++] !== ',') bad();
      f.state = f.kind === 'object' ? 'key' : 'value';
      f.empty = false;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return bad();
  }
}
