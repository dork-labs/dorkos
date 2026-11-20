/**
 * The agent browser never hands an agent a way to run its own script in a
 * page or to drive the browser's debugging protocol, and never touches
 * WebAuthn (DOR-3647: a passkey on this computer is the owner's alone).
 *
 * Read from the source: every `evaluate` runs a function written right there,
 * every protocol call names a method from the list below as a literal, and the
 * WebAuthn domain appears nowhere. A new method or a script built from input
 * fails here until it is reviewed and listed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOTS = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../browser')];

/** The protocol methods the agent browser may call, each with a fixed purpose. */
const ALLOWED_CDP = new Set([
  'Fetch.enable',
  'Fetch.continueRequest',
  'Fetch.continueResponse',
  'Fetch.failRequest',
  'Fetch.disable',
  'Page.stopLoading',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  // Only from `agent-window/full-screen-guard.ts`, with a fixed expression.
  'Runtime.evaluate',
]);

/** Every non-test TypeScript file under a folder. */
function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = ROOTS.flatMap(sourceFiles).map((file) => ({
  file,
  text: fs.readFileSync(file, 'utf8'),
}));

describe('the agent browser runs no script it was handed', () => {
  it('never names the WebAuthn domain', () => {
    expect(files.filter(({ text }) => /WebAuthn\./.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it('calls only listed protocol methods, each named as a literal', () => {
    const unlisted: string[] = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.send\(\s*([^,)]+)/g)) {
        const arg = match[1]!.trim();
        const literal = /^'([A-Za-z]+\.[A-Za-z]+)'$/.exec(arg)?.[1];
        if (!literal || !ALLOWED_CDP.has(literal)) unlisted.push(`${path.basename(file)}: ${arg}`);
      }
    }
    expect(unlisted).toEqual([]);
  });

  it('evaluates only functions written in place', () => {
    const fromInput: string[] = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.evaluate(?:Handle)?\(\s*([^\s,)]+)/g)) {
        const arg = match[1]!;
        if (!/^(\(|function\b|async\b)/.test(arg)) fromInput.push(`${path.basename(file)}: ${arg}`);
      }
    }
    expect(fromInput).toEqual([]);
  });

  it('the one Runtime.evaluate runs a fixed expression', () => {
    const callers = files.filter(({ text }) => text.includes("'Runtime.evaluate'"));
    expect(callers.map(({ file }) => path.basename(file))).toEqual(['full-screen-guard.ts']);
  });
});
