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
].map((parts) => parts.join(''));

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

  it('no file in the account or usage directories reaches for credentials or a usage endpoint', async () => {
    const hits: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of await productionFiles(dir)) {
        const text = await readFile(file, 'utf8');
        for (const needle of FORBIDDEN) {
          if (text.includes(needle)) hits.push(`${path.relative(dir, file)}: ${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
