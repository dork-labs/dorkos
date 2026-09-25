/**
 * The root `@dorkos/marketplace` entry is loaded by the React client, so
 * nothing it reaches may import a Node.js builtin: one `node:fs` import there
 * stops the whole app from starting in the browser. Node-only modules are
 * reached through subpaths (`./package-validator`, `./agent-workspace-config`).
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'child_process', 'crypto', 'url', 'stream']);

/** Value imports and re-exports in `file`, ignoring type-only ones. */
function specifiersOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms;
  for (const match of source.matchAll(re)) found.push(match[1]!);
  return found;
}

/** Every module the root entry reaches by relative value imports, with what each imports. */
function reachable(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [path.join(SRC, 'index.ts')];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const specifiers = specifiersOf(file);
    seen.set(file, specifiers);
    for (const s of specifiers) {
      if (s.startsWith('.'))
        queue.push(path.resolve(path.dirname(file), s.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('the root @dorkos/marketplace entry', () => {
  it('reaches no Node.js builtin, so the browser client can load it', () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of reachable()) {
      for (const s of specifiers) {
        if (s.startsWith('node:') || NODE_BUILTINS.has(s.split('/')[0]!)) {
          offenders.push(`${path.relative(SRC, file)} imports ${s}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
