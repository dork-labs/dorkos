/**
 * Census: the publishers whose sender is not a constant they chose, but read
 * off something they were handed, or left to options they did not write.
 *
 * The limits the server stamps on a message are sealed for the sender it goes
 * from (`sealTurnLimits`), so a publisher that passes a payload on under that
 * payload's own sender keeps the seal whole. That is right only where the
 * payload is the server's. This fails when a publisher joins the list, so its
 * reading of the payload is decided, not inherited.
 *
 * It reads the source of the server and every package with comments removed,
 * finds each `.publish(` call, and reads its options argument for a sender that
 * is reused: `from: <something>.from`, a shorthand `from`, a spread, or an
 * options object built first that does one of those. Options passed in whole
 * are listed too, since what they carry is decided elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../..');

/** Every directory a relay publisher can live in. */
const ROOTS = [
  'apps/server/src',
  ...fs
    .readdirSync(path.join(REPO, 'packages'))
    .map((name) => `packages/${name}/src`)
    .filter((dir) => fs.existsSync(path.join(REPO, dir))),
];

/** Every non-test source file under a directory, relative to the repo. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['__tests__', 'node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(rel);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/** The index just past a string literal that opens at `at`. */
function pastString(source: string, at: number): number {
  let i = at + 1;
  for (; i < source.length && source[i] !== source[at]; i++) if (source[i] === '\\') i++;
  return i + 1;
}

/** A source with its comments blanked, so a comment can neither add a call nor hide one. */
function withoutComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const end = pastString(source, i);
      out += source.slice(i, end);
      i = end;
    } else if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The top-level arguments of the bracket that opens at `open`, each trimmed. */
function argumentsAt(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') i = pastString(source, i) - 1;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (--depth === 0) return [...args, source.slice(start, i).trim()].filter(Boolean);
    } else if (c === ',' && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** How an options object reuses a sender, or `null` when it names its own. */
function reuseIn(options: string): string | null {
  if (/\bfrom:\s*[\w$.?!]*\.from\b/.test(options)) return 'from: <x>.from';
  if (/(^|[{,])\s*from\s*(?=[,}]|$)/.test(options)) return 'shorthand from';
  if (/\.\.\.\s*[\w$(]/.test(options)) return 'spread';
  return null;
}

/** Each `.publish(` call in a source whose sender is reused, as how it is reused. */
function sendersReused(raw: string): string[] {
  const source = withoutComments(raw);
  const found: string[] = [];
  for (const call of source.matchAll(/\.publish\(/g)) {
    const options = argumentsAt(source, call.index + call[0].length - 1)[2];
    if (options === undefined) continue;
    if (!/^[\w$.]+$/.test(options)) {
      const kind = reuseIn(options);
      if (kind) found.push(kind);
      continue;
    }
    const name = options.replace(/[.$]/g, '\\$&');
    const built = new RegExp(`(?:const|let)\\s+${name}\\b[^=;]*=\\s*\\{`).exec(source);
    if (!built) {
      found.push('options passed in');
      continue;
    }
    const kind = reuseIn(argumentsAt(source, built.index + built[0].length - 1).join(','));
    if (kind) found.push(`${kind}, built first`);
  }
  return found;
}

/** The publishers allowed on the list, each call as `sendersReused` reads it, and why. */
const ALLOWED: Record<string, { calls: string[]; why: string }> = {
  'apps/server/src/services/relay/binding-router.ts': {
    calls: ['from: <x>.from'],
    why: 'delivers the same message on to its bound chat, so the sender and the seal stay as stamped',
  },
  'apps/server/src/routes/relay-delivery-receipts.ts': {
    calls: ['from: <x>.from'],
    why: 'sends what `relayMessageSender` decided: the sender, and a payload without the caller’s copy',
  },
  'apps/server/src/services/relay/chat-bridge/deliver.ts': {
    calls: ['shorthand from'],
    why: 'a `relay.bridge.*` sender built by `buildBridgePrincipal`, on a room post the server wrote',
  },
  'apps/server/src/services/notifications/channels/relay.ts': {
    calls: ['shorthand from'],
    why: 'a bridge sender it builds or the server-resolved sender, on a notice the server wrote',
  },
  'apps/server/src/services/observability/trace-relay.ts': {
    calls: ['options passed in'],
    why: 'the tracing wrapper hands its caller’s options on unchanged',
  },
  'apps/server/src/services/relay/binding-subsystem.ts': {
    calls: ['options passed in'],
    why: 'the publisher adapters are given hands their options on unchanged',
  },
  'packages/relay/src/relay-core.ts': {
    calls: ['options passed in', 'options passed in', 'options passed in'],
    why: 'the bus’s own publish, handing options to its pipeline',
  },
  'packages/relay/src/adapters/webhook/webhook-adapter.ts': {
    calls: ['spread'],
    why: 'spreads only the budget a webhook chain continues; the sender is its own address',
  },
  'apps/server/src/services/rooms/reseat/seat-replacement.ts': {
    calls: ['spread'],
    why: 'not a relay publish: the required-launch store',
  },
  'packages/browser/src/runtime/installation/transaction.ts': {
    calls: ['options passed in'],
    why: 'not a relay publish: an install transaction’s file step',
  },
};

describe('the relay sender reuse census', () => {
  it('lets only the known publishers reuse a sender', () => {
    const found = Object.fromEntries(
      ROOTS.flatMap(sourceFiles)
        .map((file) => [file, sendersReused(fs.readFileSync(path.join(REPO, file), 'utf8'))])
        .filter(([, calls]) => calls.length > 0)
    );
    expect(found).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([file, { calls }]) => [file, calls]))
    );
  });

  it.each([
    [
      'a sender read off an envelope',
      'relay.publish(s, p, { from: envelope.from })',
      'from: <x>.from',
    ],
    ['a shorthand sender', 'relay.publish(s, p, { from, budget })', 'shorthand from'],
    ['a spread', 'relay.publish(s, p, { ...envelope })', 'spread'],
    [
      'options built first',
      'const opts = { budget, from: e.from };\nrelay.publish(s, p, opts);',
      'from: <x>.from, built first',
    ],
    [
      'options passed in',
      'function f(opts) { return relay.publish(s, p, opts); }',
      'options passed in',
    ],
    [
      'a call across lines with nested braces and a bracket in a string',
      "relay.publish(\n  subject,\n  { note: ')', extra: f(a, b) },\n  { from: msg.from }\n);",
      'from: <x>.from',
    ],
  ])('reads %s', (_name, source, kind) => {
    expect(sendersReused(source)).toEqual([kind]);
  });

  it.each([
    ['its own sender', 'relay.publish(s, p, { from: SENDER })'],
    [
      'options built first with its own sender',
      'const opts = { from: `agent:${id}` };\nrelay.publish(s, p, opts);',
    ],
    [
      'a call inside a comment',
      '// relay.publish(s, p, { from: envelope.from })\n/* relay.publish(s, p, { from }) */',
    ],
  ])('passes %s', (_name, source) => {
    expect(sendersReused(source)).toEqual([]);
  });
});
