/**
 * Usage is only read from what the official binary hands over (spec
 * `claude-account-fleet` invariant 3, §8): no Keychain read, no credentials file,
 * no token, no call to a usage endpoint from DorkOS code. A textual guard over
 * every production file in the two account directories, so the next change
 * that reaches for a shortcut fails here rather than in review.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARDED_DIRS = [path.resolve(HERE, '..'), path.resolve(HERE, '../../../../core/usage')];

/** Spelled in pieces, so this file does not trip a scan of its own directory. */
const FORBIDDEN = [
  ['find-generic', 'password'],
  ['Key', 'chain'],
  ['.credentials', '.json'],
  ['oauth/', 'usage'],
  ['CLAUDE_CODE_', 'OAUTH_TOKEN'],
  ['ANTHROPIC_', 'AUTH_TOKEN'],
  // No network call of our own: every reading comes from the official binary.
  ['api.', 'anthropic.com'],
  ['und', 'ici'],
].map((parts) => parts.join(''));

/** Network modules, however they are imported, and any `fetch` call. */
const NETWORK_MODULE = String.raw`['"](?:node:)?(?:https?|http2|net|tls|dgram)['"]`;
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bfrom\s+${NETWORK_MODULE}`),
  new RegExp(String.raw`\bimport\s+${NETWORK_MODULE}`),
  new RegExp(String.raw`\brequire\(\s*${NETWORK_MODULE}`),
  new RegExp(String.raw`\bimport\(\s*${NETWORK_MODULE}`),
  /\bfetch\s*\(/,
];

/** Every forbidden string or pattern `text` contains. */
function violations(text: string): string[] {
  return [
    ...FORBIDDEN.filter((needle) => text.includes(needle)),
    ...FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(text)).map(String),
  ];
}

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...(await productionFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('account usage compliance guard (invariant 3)', () => {
  it('scans a non-empty set of files', async () => {
    for (const dir of GUARDED_DIRS) expect((await productionFiles(dir)).length).toBeGreaterThan(0);
  });

  it('covers the account probe, which boots the CLI on an account folder (spec D3)', async () => {
    const files = (await productionFiles(GUARDED_DIRS[0]!)).map((f) => path.basename(f));
    expect(files).toContain('account-probe.ts');
  });

  it('catches every spelling of a network import or fetch call', () => {
    for (const snippet of [
      "import https from 'https';",
      "import http from 'node:http';",
      'import * as tls from "node:tls";',
      "import { request } from 'http2';",
      "import 'net';",
      "const dns = require('dgram');",
      "const h = require( 'node:https' );",
      "const m = await import('tls');",
      'await fetch (url);',
      'await fetch(url);',
      'globalThis.fetch(url);',
    ]) {
      expect(violations(snippet), snippet).not.toEqual([]);
    }
    for (const allowed of [
      "import path from 'node:path';",
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      'const prefetch = 1;',
    ]) {
      expect(violations(allowed), allowed).toEqual([]);
    }
  });

  it('no file in the account or usage directories reaches for credentials or a usage endpoint', async () => {
    const hits: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of await productionFiles(dir)) {
        const text = await readFile(file, 'utf8');
        for (const hit of violations(text)) hits.push(`${path.relative(dir, file)}: ${hit}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

/**
 * The per-token billing check decides whether a session is shown its account's
 * subscription bar, so it sits on the usage path too: it may look at which
 * variable NAMES are set, and must never resolve a stored key. It is therefore
 * guarded like the account directories, with the two variable names it checks
 * for allowed, and it may not import the credential resolver or provider
 * (either one resolves a reference to its secret).
 */
describe('per-token billing compliance guard (invariant 3)', () => {
  const FILE = path.resolve(HERE, '../../messaging/per-token-billing.ts');
  const ALLOWED = new Set([['ANTHROPIC_', 'AUTH_TOKEN'].join('')]);
  // Anywhere in the text, so a dynamic `import()` or a re-export is caught too.
  const FORBIDDEN_IMPORTS = [/credential-(env|provider)/];

  it('names no credential store or usage endpoint, and imports nothing that resolves a secret', async () => {
    const text = await readFile(FILE, 'utf8');
    const hits = FORBIDDEN.filter((needle) => !ALLOWED.has(needle) && text.includes(needle));
    for (const pattern of FORBIDDEN_IMPORTS) {
      if (pattern.test(text)) hits.push(String(pattern));
    }
    expect(hits).toEqual([]);
  });
});
