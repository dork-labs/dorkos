/**
 * Only the app's approval route may grant a capability approval (DOR-4778).
 *
 * Every surface that can say Allow must show the card's full detail: a
 * `config_patch` card's list of settings is the only place every changed
 * setting is named. Today the one surface that grants is the app's card, through
 * `POST /api/approvals/:id/grant`, and it always shows the detail. A chat bridge
 * (Telegram, Slack) answers a session's own tool ask, never one of these. A new
 * caller of the service's `grant` would be a new surface, so this fails until
 * someone decides whether it shows the detail or withholds Allow.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', '..', '..');

/** The files allowed to grant a capability approval, relative to `src`. */
const GRANTING_FILES = ['routes/approvals.ts'];

/** A call to the approval service's grant, by whatever name holds it. */
const GRANT_CALL = /\b\w*[aA]pprovals?\w*\.grant\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('who may grant a capability approval', () => {
  it('is the approval route alone, so every Allow shows the full detail', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => GRANT_CALL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'));
    expect(callers.sort()).toEqual(GRANTING_FILES);
  });
});
