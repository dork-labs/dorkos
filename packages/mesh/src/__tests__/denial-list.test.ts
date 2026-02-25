import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as nodefs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { DenialList } from '../denial-list.js';

// === Setup ===

let tmpDir: string;
let db: Database.Database;
let denialList: DenialList;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-denial-test-'));
  const dbPath = path.join(tmpDir, 'mesh.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  denialList = new DenialList(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// === Tests ===

describe('deny and isDenied', () => {
  it('round-trip: deny a path, then isDenied returns true', () => {
    const dir = path.join(tmpDir, 'project-a');
    denialList.deny(dir, 'claude-code', 'Not a project', 'user');
    expect(denialList.isDenied(dir)).toBe(true);
  });

  it('isDenied returns false for non-denied path', () => {
    const dir = path.join(tmpDir, 'project-b');
    expect(denialList.isDenied(dir)).toBe(false);
  });

  it('deny() preserves reason string', () => {
    const dir = path.join(tmpDir, 'project-c');
    denialList.deny(dir, 'cursor', 'Not relevant', 'admin');

    const records = denialList.list();
    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe('Not relevant');
  });

  it('deny() works with no reason (undefined)', () => {
    const dir = path.join(tmpDir, 'project-d');
    denialList.deny(dir, 'codex', undefined, 'system');

    const records = denialList.list();
    expect(records[0].reason).toBeUndefined();
  });

  it('re-denying the same path updates the record (INSERT OR REPLACE)', () => {
    const dir = path.join(tmpDir, 'project-e');
    denialList.deny(dir, 'claude-code', 'First reason', 'user');
    denialList.deny(dir, 'claude-code', 'Updated reason', 'admin');

    const records = denialList.list();
    // Should still only have one record
    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe('Updated reason');
    expect(records[0].deniedBy).toBe('admin');
  });
});

describe('clear', () => {
  it('removes a denial and returns true', () => {
    const dir = path.join(tmpDir, 'project-f');
    denialList.deny(dir, 'claude-code', undefined, 'user');

    const result = denialList.clear(dir);
    expect(result).toBe(true);
    expect(denialList.isDenied(dir)).toBe(false);
  });

  it('returns false when path was not denied', () => {
    const dir = path.join(tmpDir, 'project-g');
    expect(denialList.clear(dir)).toBe(false);
  });
});

describe('list', () => {
  it('returns all denial records', () => {
    denialList.deny(path.join(tmpDir, 'p1'), 'claude-code', undefined, 'user');
    denialList.deny(path.join(tmpDir, 'p2'), 'cursor', 'Test reason', 'admin');

    const records = denialList.list();
    expect(records).toHaveLength(2);
  });

  it('returns empty array when no denials exist', () => {
    expect(denialList.list()).toEqual([]);
  });
});

describe('path canonicalization', () => {
  it('canonicalizes symlinked paths so the real path is denied', async () => {
    // Create a real directory and a symlink to it
    const realDir = path.join(tmpDir, 'real-project');
    await fs.mkdir(realDir);
    const linkDir = path.join(tmpDir, 'link-project');
    nodefs.symlinkSync(realDir, linkDir);

    // Deny via symlink path
    denialList.deny(linkDir, 'claude-code', undefined, 'user');

    // Check via real path (realpath resolution should match)
    const realPath = nodefs.realpathSync(realDir);
    expect(denialList.isDenied(realPath)).toBe(true);
  });
});

describe('persistence', () => {
  it('denials survive db close and reopen', async () => {
    const dir = path.join(tmpDir, 'project-h');
    denialList.deny(dir, 'claude-code', 'Persistent', 'user');

    db.close();

    // Reopen
    const dbPath = path.join(tmpDir, 'mesh.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    denialList = new DenialList(db);

    expect(denialList.isDenied(dir)).toBe(true);
  });
});
