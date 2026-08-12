/**
 * What a path that does not exist YET is judged by (DOR-1185).
 *
 * The sibling `boundary.test.ts` mocks `fs/promises` wholesale, so it can state
 * what the validators do with a realpath result but not what realpath itself
 * would have said. Symlink containment is exactly the question a mock cannot
 * answer, so every case here builds REAL directories and REAL symlinks in a
 * temp tree and drives the REAL validators.
 *
 * The hole this file pins was found reviewing DOR-1174: `resolveCanonicalPath`
 * fell back to a LEXICAL `path.resolve` whenever `fs.realpath` threw ENOENT, so
 * a non-existent CHILD of a symlink was judged by its spelling rather than its
 * target — `{dorkHome}/agents/escape/nope`, where `escape` points at the
 * encrypted credential store, was ALLOWED. The fix judges the remainder against
 * the deepest ancestor that does exist, which is the symlink itself.
 *
 * Two directions are pinned, because a fix that only refused things would be
 * easy and wrong: the escapes must be refused, AND paths that legitimately do
 * not exist yet (a workspace about to be cloned, a workbench file about to be
 * created) must still validate.
 *
 * @module lib/__tests__/boundary-symlink-enoent
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initBoundary, validateBoundary, validateBoundaryOrDorkHome } from '../boundary.js';

let tmpRoot: string;
/** The configured boundary root — the operator's allowed area. */
let BOUNDARY: string;
/** An existing project directory inside the boundary. */
let PROJECT: string;
/** A directory outside every allowed root. */
let OUTSIDE: string;
/** DorkOS's data directory, deliberately outside the boundary (the Docker shape). */
let DORK_HOME: string;
/** The encrypted credential store: a dork-home sibling of `agents/`. */
let SECRETS: string;

const originalDorkHome = process.env.DORK_HOME;

beforeAll(async () => {
  // realpath'd up front: macOS hands out `/var/...` temp dirs that resolve to
  // `/private/var/...`, and every containment check compares resolved paths.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor1185-')));
  BOUNDARY = path.join(tmpRoot, 'workspace');
  PROJECT = path.join(BOUNDARY, 'project');
  OUTSIDE = path.join(tmpRoot, 'elsewhere');
  DORK_HOME = path.join(tmpRoot, 'dork-home');
  SECRETS = path.join(DORK_HOME, 'extension-secrets');

  for (const dir of [PROJECT, OUTSIDE, SECRETS, path.join(DORK_HOME, 'agents', 'dorkbot')]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // The DOR-1174 probe: a symlink INSIDE the agents carve-out, pointing at the
  // credential store next door.
  await fs.symlink(SECRETS, path.join(DORK_HOME, 'agents', 'escape'));
  // The same shape on the plain boundary: a symlink inside the project that
  // leaves the boundary entirely.
  await fs.symlink(OUTSIDE, path.join(PROJECT, 'escape'));
  // A symlink that stays inside the boundary — the control for "followed", not
  // "refused".
  await fs.mkdir(path.join(PROJECT, 'real'), { recursive: true });
  await fs.symlink(path.join(PROJECT, 'real'), path.join(PROJECT, 'inner'));
  // A DANGLING symlink: its target does not exist, so `realpath` on the link
  // itself throws ENOENT just as a missing file would.
  await fs.symlink(path.join(OUTSIDE, 'not-there'), path.join(PROJECT, 'dangling'));

  process.env.DORK_HOME = DORK_HOME;
  await initBoundary(BOUNDARY);
});

afterAll(async () => {
  if (originalDorkHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = originalDorkHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('a non-existent path is judged by its target, not its spelling', () => {
  it('refuses a non-existent child of a symlink that leaves the agents subtree', async () => {
    // The DOR-1174 probe, verbatim. `escape` exists and points at the credential
    // store; `nope` under it does not exist. Judged lexically it reads as
    // `{dorkHome}/agents/...` and passes the carve-out.
    const probe = path.join(DORK_HOME, 'agents', 'escape', 'nope');

    await expect(validateBoundaryOrDorkHome(probe)).rejects.toMatchObject({
      name: 'BoundaryError',
      code: 'OUTSIDE_BOUNDARY',
    });
  });

  it('refuses a non-existent child of a symlink that leaves the boundary', async () => {
    const probe = path.join(PROJECT, 'escape', 'new-file.txt');

    await expect(validateBoundary(probe)).rejects.toMatchObject({
      name: 'BoundaryError',
      code: 'OUTSIDE_BOUNDARY',
    });
  });

  it('refuses a non-existent path nested several levels under an escaping symlink', async () => {
    // The walk has to climb more than one missing level to reach the symlink.
    const probe = path.join(PROJECT, 'escape', 'a', 'b', 'c.txt');

    await expect(validateBoundary(probe)).rejects.toMatchObject({
      code: 'OUTSIDE_BOUNDARY',
    });
  });

  it('refuses a dangling symlink whose target is outside the boundary', async () => {
    // `realpath` throws ENOENT on a dangling link exactly as it does on a
    // missing file, so the lexical fallback allowed it — and a write through it
    // would land outside the boundary.
    const probe = path.join(PROJECT, 'dangling');

    await expect(validateBoundary(probe)).rejects.toMatchObject({
      code: 'OUTSIDE_BOUNDARY',
    });
  });

  it('refuses a non-existent child of a dangling symlink', async () => {
    const probe = path.join(PROJECT, 'dangling', 'deeper.txt');

    await expect(validateBoundary(probe)).rejects.toMatchObject({
      code: 'OUTSIDE_BOUNDARY',
    });
  });
});

describe('paths that do not exist yet still validate', () => {
  it('allows a directory about to be created inside the boundary', async () => {
    // The workspace-provisioning shape: `git clone`/`git worktree add` validate
    // their target before creating it.
    const target = path.join(BOUNDARY, 'checkouts', 'feature-x');

    await expect(validateBoundary(target)).resolves.toBe(target);
  });

  it('allows a file about to be written inside an existing project', async () => {
    const target = path.join(PROJECT, 'new-file.txt');

    await expect(validateBoundary(target)).resolves.toBe(target);
  });

  it('allows a new agent directory under the agents subtree', async () => {
    const target = path.join(DORK_HOME, 'agents', 'newbot');

    await expect(validateBoundaryOrDorkHome(target)).resolves.toBe(target);
  });

  it('returns the canonical path when the deepest existing ancestor is a symlink', async () => {
    // `inner` -> `real`, both inside the boundary. The path is allowed AND the
    // symlink is resolved, so callers judge and act on the same location.
    const target = path.join(PROJECT, 'inner', 'new-file.txt');

    await expect(validateBoundary(target)).resolves.toBe(
      path.join(PROJECT, 'real', 'new-file.txt')
    );
  });

  it('still refuses a non-existent path that is plainly outside the boundary', async () => {
    // The lexical case the old fallback got right, kept right.
    await expect(validateBoundary(path.join(OUTSIDE, 'newdir'))).rejects.toMatchObject({
      code: 'OUTSIDE_BOUNDARY',
    });
  });
});
