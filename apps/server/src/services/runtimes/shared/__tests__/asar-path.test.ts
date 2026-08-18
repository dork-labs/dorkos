/**
 * Real on-disk fixtures, no Electron: an `app.asar/` directory standing in for
 * the archive Electron's fs patch makes look like a directory, and an
 * `app.asar.unpacked/` tree holding the file that is actually spawnable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAsarUnpacked } from '../asar-path.js';

let root: string;
/** `<root>/app.asar/node_modules/pkg/bin` — resolvable, but inside the archive. */
let inAsar: string;
/** `<root>/app.asar.unpacked/node_modules/pkg/bin` — the twin that really exists. */
let unpacked: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-asar-'));
  inAsar = path.join(root, 'app.asar', 'node_modules', 'pkg', 'bin');
  unpacked = path.join(root, 'app.asar.unpacked', 'node_modules', 'pkg', 'bin');
  fs.mkdirSync(path.dirname(inAsar), { recursive: true });
  fs.mkdirSync(path.dirname(unpacked), { recursive: true });
  fs.writeFileSync(unpacked, '#!/bin/sh\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveAsarUnpacked', () => {
  // Purpose: this is the whole fix — a path inside the archive is not spawnable,
  // its `.asar.unpacked` twin is (DOR-1334 / F2).
  it('maps a path inside an asar to its unpacked twin when that twin exists', () => {
    expect(resolveAsarUnpacked(inAsar)).toBe(unpacked);
  });

  // Purpose: never invent a path. A file that was NOT unpacked has no twin, so
  // the caller's own existence check must still see the original.
  it('returns the input when no unpacked twin exists on disk', () => {
    const noTwin = path.join(root, 'app.asar', 'node_modules', 'pkg', 'other');
    expect(resolveAsarUnpacked(noTwin)).toBe(noTwin);
  });

  // Purpose: the npm CLI and dev have no asar anywhere in the path — untouched.
  it('returns an ordinary path unchanged', () => {
    const plain = path.join(root, 'node_modules', 'pkg', 'bin');
    expect(resolveAsarUnpacked(plain)).toBe(plain);
  });

  // Purpose: idempotence. A path already pointing at the unpacked tree must not
  // grow a second `.unpacked` segment.
  it('leaves an already-unpacked path alone', () => {
    expect(resolveAsarUnpacked(unpacked)).toBe(unpacked);
  });

  // Purpose: `.asar` must be a whole path SEGMENT, not a substring of a filename.
  it('ignores a file whose name merely ends in .asar', () => {
    const archiveFile = path.join(root, 'resources', 'app.asar');
    expect(resolveAsarUnpacked(archiveFile)).toBe(archiveFile);
  });
});
