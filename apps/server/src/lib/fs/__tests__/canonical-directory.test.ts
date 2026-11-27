/**
 * The one spelling of a working directory (DOR-695).
 *
 * Run against a REAL symlink on disk rather than a mocked `realpath`: the whole
 * point of this helper is what the filesystem says, and a mock would only echo
 * back the assumption being tested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalDirectory } from '../canonical-directory.js';

let base: string;
let realProject: string;
let linkedProject: string;

beforeAll(async () => {
  // `realpath` the temp root first: on macOS `os.tmpdir()` is itself under the
  // `/var` symlink, so an un-resolved fixture would make every assertion here
  // mean something other than what it says.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-canon-dir-')));
  realProject = path.join(base, 'real-project');
  await mkdir(realProject);
  await mkdir(path.join(realProject, 'packages', 'api'), { recursive: true });
  linkedProject = path.join(base, 'linked-project');
  await symlink(realProject, linkedProject);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('canonicalDirectory', () => {
  it('resolves a symlinked directory to the path it really is', () => {
    expect(canonicalDirectory(linkedProject)).toBe(realProject);
  });

  it('resolves a symlink in the MIDDLE of a path, not just at its end', () => {
    expect(canonicalDirectory(path.join(linkedProject, 'packages', 'api'))).toBe(
      path.join(realProject, 'packages', 'api')
    );
  });

  it('collapses a trailing separator, a `.` segment and a `..` hop', () => {
    expect(canonicalDirectory(`${realProject}/`)).toBe(realProject);
    expect(canonicalDirectory(path.join(realProject, '.'))).toBe(realProject);
    expect(canonicalDirectory(path.join(realProject, 'nowhere', '..'))).toBe(realProject);
  });

  it('normalizes a directory that does not exist rather than throwing', () => {
    const missing = path.join(base, 'not-created', 'sub', '..');
    expect(canonicalDirectory(missing)).toBe(path.join(base, 'not-created'));
  });

  it('does NOT follow a symlink it cannot resolve — the fallback is lexical', () => {
    // `realpath` is all-or-nothing: one missing component and it throws, so a
    // path that does not exist keeps whatever spelling it arrived in, symlinked
    // ancestors included. Stated here because it bounds the whole fix — the
    // sidecar's own resolution fails on the same path, and inventing a cleverer
    // answer would name a directory neither side ever wrote.
    const missingUnderLink = path.join(linkedProject, 'not-created');
    expect(canonicalDirectory(missingUnderLink)).toBe(missingUnderLink);
  });

  it('leaves a relative path alone, so callers can still reject it', () => {
    // Deliberate: resolving it would need a process cwd this helper has no
    // business guessing, and it would silence the OpenCode listing's explicit
    // refusal of relative input (DOR-674).
    expect(canonicalDirectory('relative/project')).toBe('relative/project');
    expect(canonicalDirectory('')).toBe('');
  });

  it('is idempotent — canonicalizing a canonical path changes nothing', () => {
    expect(canonicalDirectory(canonicalDirectory(linkedProject))).toBe(realProject);
  });
});
