/**
 * Reading and writing the file behind a room's worktree diff (spec
 * `canvas-agent-seat` §8).
 *
 * **The whole reason this seam exists is a confinement**, so the confinement is
 * what most of these cases are about. A member's working copy lives under the
 * DorkOS data directory, which the raw file API is deliberately fenced out of —
 * so the review goes through the ROOM, names a document rather than a directory,
 * and refuses every row whose recorded tree is not one this room made.
 *
 * Real files in a real temporary directory, because the thing under test is a
 * read and a write against a path that was composed: a mocked filesystem would
 * accept the traversal this file exists to refuse.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the `isContained(treeReal, worktreesReal)` check reddens "refuses a
 *   document whose tree is not one this room keeps".
 * - Dropping the `isContained(file, treeReal)` check reddens "refuses a stored
 *   path that climbs out of its own copy".
 * - Going back to a lexical `path.relative` — no `resolveCanonicalPath` —
 *   reddens both symlink cases: the review followed a link planted inside the
 *   working copy and read, then OVERWROTE, a file outside it. That is what the
 *   adversarial review measured on round 1, and it is the reason this module
 *   borrows `lib/boundary.ts`'s resolution rather than writing a second one.
 * - Comparing nothing instead of the expected hash reddens "refuses to clobber
 *   a file the agent changed underneath the review".
 * - Dropping the `treeReal === worktreesReal` guard reddens "refuses the
 *   worktrees directory ITSELF as a tree": `isContained` counts a path equal to
 *   the root as contained, which the lexical helper it replaced did not.
 *
 * @module server/services/rooms/canvas/tests/canvas-diff-review
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readCanvasDiffReview,
  writeCanvasDiffReview,
  type CanvasDiffReviewDeps,
} from '../canvas-diff-review.js';
import { RoomError } from '../../room-errors.js';

const ROOM = 'room-1';
const DOCUMENT = 'doc-1';

/** SHA-256 of a string, the way the seam fingerprints a file. */
const hashOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the file behind a room worktree diff', () => {
  let home: string;
  let worktrees: string;
  let copy: string;
  let deps: CanvasDiffReviewDeps;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-diff-review-'));
    worktrees = path.join(home, 'worktrees');
    copy = path.join(worktrees, 'ana');
    await fs.mkdir(path.join(copy, 'src'), { recursive: true });
    await fs.writeFile(path.join(copy, 'src', 'app.ts'), 'const a = 2;\n', 'utf-8');
    deps = {
      document: () => ({ contentType: 'diff', sourcePath: 'src/app.ts' }),
      resolvedTree: () => copy,
      worktreesPath: () => worktrees,
      mainCopy: async () => 'const a = 1;\n',
    };
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('answers with both copies and the fingerprint a write must carry back', async () => {
    const review = await readCanvasDiffReview(deps, ROOM, DOCUMENT);

    expect(review).toMatchObject({
      path: 'src/app.ts',
      base: 'const a = 1;\n',
      current: 'const a = 2;\n',
    });
    expect(review.currentHash).toBe(hashOf('const a = 2;\n'));
  });

  it('draws a file this work ADDS against an empty base, which is not an error', async () => {
    // The ordinary case for new work: `main` has never had this file.
    const review = await readCanvasDiffReview(
      { ...deps, mainCopy: async () => null },
      ROOM,
      DOCUMENT
    );

    expect(review.base).toBe('');
    expect(review.current).toBe('const a = 2;\n');
  });

  it('refuses a document that is not a review at all', async () => {
    const notADiff = { ...deps, document: () => null };
    await expect(readCanvasDiffReview(notADiff, ROOM, DOCUMENT)).rejects.toBeInstanceOf(RoomError);
  });

  it('refuses a room that has no files of its own', async () => {
    const noRepo = { ...deps, worktreesPath: () => null };
    await expect(readCanvasDiffReview(noRepo, ROOM, DOCUMENT)).rejects.toThrow(
      /does not have files of its own/
    );
  });

  it('refuses a document whose tree is not one this room keeps', async () => {
    // Somebody's own project, or a path a row picked up from anywhere else. The
    // stored directory is an input, not a fact, and this is the check that says
    // so — without it the review is a read primitive over the whole disk.
    const elsewhere = { ...deps, resolvedTree: () => path.join(home, 'not-a-worktree') };
    await expect(readCanvasDiffReview(elsewhere, ROOM, DOCUMENT)).rejects.toThrow(
      /this room does not keep working copies/
    );
  });

  it('refuses the worktrees directory ITSELF as a tree', async () => {
    // `isContained` reads a path equal to the root as contained, where the
    // lexical helper it replaced did not. Unreachable today — the server writes
    // one specific copy, never its parent — so this exists to hold the rule
    // where the swap changed the semantics under it.
    const asTheRoot = { ...deps, resolvedTree: () => worktrees };
    await expect(readCanvasDiffReview(asTheRoot, ROOM, DOCUMENT)).rejects.toThrow(
      /this room does not keep working copies/
    );
  });

  it('refuses a stored path that climbs out of its own copy', async () => {
    const escaping = {
      ...deps,
      document: () => ({ contentType: 'diff', sourcePath: '../../../etc/passwd' }),
    };
    await expect(readCanvasDiffReview(escaping, ROOM, DOCUMENT)).rejects.toThrow(
      /this room does not keep working copies/
    );
  });

  it('refuses a document that is not a review, rather than answering as a missing one', async () => {
    // Reachable, which it was not: the route's seam used to pre-filter every
    // non-`diff` document to `null`, so a markdown document on the table
    // answered `CANVAS_DOCUMENT_NOT_FOUND`. The seam now reports what the table
    // holds and the rule lives here.
    const markdown = { ...deps, document: () => ({ contentType: 'markdown', sourcePath: 'a.md' }) };
    await expect(readCanvasDiffReview(markdown, ROOM, DOCUMENT)).rejects.toThrow(
      /not a review of somebody’s working copy/
    );
  });

  it('refuses to READ through a symlink planted inside the working copy', async () => {
    // The round-1 blocker, in the shape it was measured: a link inside the copy
    // pointing at a file outside it. A lexical `path.relative` sees a path that
    // starts with the tree and lets it through; the realpath sees where it
    // actually goes.
    const secret = path.join(home, 'secrets.json');
    await fs.writeFile(secret, '{"token":"REAL-SECRET"}\n', 'utf-8');
    await fs.symlink(secret, path.join(copy, 'src', 'notes.md'));
    const throughLink = {
      ...deps,
      document: () => ({ contentType: 'diff', sourcePath: 'src/notes.md' }),
    };

    await expect(readCanvasDiffReview(throughLink, ROOM, DOCUMENT)).rejects.toThrow(
      /this room does not keep working copies/
    );
  });

  it('refuses to WRITE through one, and leaves the file outside untouched', async () => {
    const secret = path.join(home, 'secrets.json');
    await fs.writeFile(secret, '{"token":"REAL-SECRET"}\n', 'utf-8');
    await fs.symlink(secret, path.join(copy, 'src', 'notes.md'));
    const throughLink = {
      ...deps,
      document: () => ({ contentType: 'diff', sourcePath: 'src/notes.md' }),
    };

    await expect(
      writeCanvasDiffReview(throughLink, ROOM, DOCUMENT, {
        content: '{"token":"OVERWRITTEN"}\n',
        expectedHash: hashOf('{"token":"REAL-SECRET"}\n'),
      })
    ).rejects.toThrow(/this room does not keep working copies/);

    // The assertion that matters: the refusal is not the only thing checked,
    // the bytes are.
    expect(await fs.readFile(secret, 'utf-8')).toBe('{"token":"REAL-SECRET"}\n');
  });

  it('refuses a tree that only LOOKS like one of this room’s copies', async () => {
    // A link at the worktree level, rather than inside one. Same rule, one
    // directory up: the row's stored tree is an input either way.
    const outside = path.join(home, 'somewhere-else');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(worktrees, 'ben'));
    const linkedTree = { ...deps, resolvedTree: () => path.join(worktrees, 'ben') };

    await expect(readCanvasDiffReview(linkedTree, ROOM, DOCUMENT)).rejects.toThrow(
      /this room does not keep working copies/
    );
  });

  it('writes a reviewed file back into the working copy', async () => {
    const result = await writeCanvasDiffReview(deps, ROOM, DOCUMENT, {
      content: 'const a = 1;\n',
      expectedHash: hashOf('const a = 2;\n'),
    });

    expect(result).toMatchObject({ ok: true, hash: hashOf('const a = 1;\n') });
    expect(await fs.readFile(path.join(copy, 'src', 'app.ts'), 'utf-8')).toBe('const a = 1;\n');
  });

  it('refuses to clobber a file the agent changed underneath the review', async () => {
    const result = await writeCanvasDiffReview(deps, ROOM, DOCUMENT, {
      content: 'const a = 1;\n',
      expectedHash: hashOf('what the diff was computed against'),
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { currentHash: hashOf('const a = 2;\n'), currentContent: 'const a = 2;\n' },
    });
    // Nothing was written: a conflict is control flow, and the file is exactly
    // as the agent left it.
    expect(await fs.readFile(path.join(copy, 'src', 'app.ts'), 'utf-8')).toBe('const a = 2;\n');
  });

  it('says so when the file is not in the working copy any more', async () => {
    await fs.rm(path.join(copy, 'src', 'app.ts'));
    await expect(readCanvasDiffReview(deps, ROOM, DOCUMENT)).rejects.toThrow(
      /not in the working copy any more/
    );
  });
});
