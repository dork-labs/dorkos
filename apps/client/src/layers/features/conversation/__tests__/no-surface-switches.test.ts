/**
 * The one mechanical guarantee that capability flags survive contact.
 *
 * `ConversationCapabilities` exists so behaviour never branches on which of the
 * three presentations a conversation is. That is easy to state and easy to
 * erode: the first `if (surface === 'room')` looks harmless, and by the fifth
 * the compound is two components sharing a file. So the rule is scanned rather
 * than asked for, in the manner of `sse-event-allowlist.test.ts` — a textual
 * cross-check over source, which is the only kind of check that can catch a
 * decision being unpicked one line at a time.
 *
 * `ConversationRoot.tsx` is the single exception: it is where a host says which
 * surface this is, and nothing below it may ask again.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolved from the repo root rather than from `import.meta.url`: this suite
// runs under the client's Vite transform, where the module URL is not a `file:`
// one and `fileURLToPath` refuses it.
const UI_DIR = path.resolve(process.cwd(), 'apps/client/src/layers/features/conversation/ui');

/** The one file allowed to compare a surface — the provider itself. */
const ALLOWED = 'ConversationRoot.tsx';

/** Every source file under the slice's `ui/`, recursively, path relative to it. */
function sourceFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : path.join(prefix, entry.name);
    if (entry.isDirectory()) return sourceFiles(path.join(dir, entry.name), rel);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [rel] : [];
  });
}

describe('features/conversation — no part asks which surface it is on', () => {
  const files = sourceFiles(UI_DIR);

  it('scans the whole of ui/, so a clean result means something', () => {
    // Without this, a scan that resolved the wrong directory would report an
    // empty violation list and read exactly like a pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(ALLOWED);
    expect(files.some((f) => f.startsWith('message'))).toBe(true);
    expect(files.some((f) => f.startsWith('rows'))).toBe(true);
  });

  it('finds no `surface ===` outside the provider', () => {
    const offenders = files.filter((file) => {
      if (file === ALLOWED) return false;
      return readFileSync(path.join(UI_DIR, file), 'utf8').includes('surface ===');
    });

    expect(
      offenders,
      'a part branched on which surface it is on — the difference belongs in ConversationCapabilities, declared by the host'
    ).toEqual([]);
  });
});
