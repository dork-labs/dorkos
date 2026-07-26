/**
 * Real-filesystem tests for {@link ScaffoldLedger} (DOR-507).
 *
 * The ledger's whole job is to delete what a scaffold run made and nothing
 * else, so these tests set up the "and nothing else" cases directly: a path
 * that was already taken, a symlink, and a path that changed type between the
 * write and the rollback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ScaffoldLedger } from '../scaffold-ledger.js';

let root: string;

/** Whether anything exists at `p`, symlinks included. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-ledger-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ScaffoldLedger', () => {
  it('removes a file it claimed and wrote', async () => {
    const ledger = new ScaffoldLedger();
    const file = path.join(root, 'written.txt');

    await ledger.claimFile(file);
    await fs.writeFile(file, 'new', 'utf-8');

    expect(await ledger.rollback()).toEqual({ removed: [file], kept: [] });
    expect(await exists(file)).toBe(false);
  });

  it('never claims a path that is already taken', async () => {
    const ledger = new ScaffoldLedger();
    const file = path.join(root, 'theirs.txt');
    await fs.writeFile(file, 'theirs', 'utf-8');

    await ledger.claimFile(file);
    await fs.writeFile(file, 'ours', 'utf-8');

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [] });
    expect(await fs.readFile(file, 'utf-8')).toBe('ours');
  });

  it('never claims a symlink', async () => {
    const ledger = new ScaffoldLedger();
    const target = path.join(root, 'target.txt');
    const link = path.join(root, 'link.txt');
    await fs.writeFile(target, 'target', 'utf-8');
    await fs.symlink(target, link);

    await ledger.claimFile(link);

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [] });
    expect(await exists(link)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it('keeps a claimed path that turned into a symlink before rollback', async () => {
    const ledger = new ScaffoldLedger();
    const target = path.join(root, 'target.txt');
    const file = path.join(root, 'swapped.txt');
    await fs.writeFile(target, 'target', 'utf-8');

    await ledger.claimFile(file);
    await fs.symlink(target, file);

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [file] });
    expect(await exists(file)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it('keeps a claimed path that another process turned into a directory', async () => {
    const ledger = new ScaffoldLedger();
    const p = path.join(root, 'raced');

    await ledger.claimFile(p);
    await fs.mkdir(p);
    await fs.writeFile(path.join(p, 'theirs.txt'), 'theirs', 'utf-8');

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [p] });
    expect(await fs.readFile(path.join(p, 'theirs.txt'), 'utf-8')).toBe('theirs');
  });

  it('reports nothing for a claimed path that was never written', async () => {
    const ledger = new ScaffoldLedger();

    await ledger.claimFile(path.join(root, 'never-written.txt'));

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [] });
  });

  it('records a directory it created and removes it once it is empty', async () => {
    const ledger = new ScaffoldLedger();
    const dir = path.join(root, 'made');
    const file = path.join(dir, 'inside.txt');

    expect(await ledger.mkdir(dir)).toBe(true);
    await ledger.claimFile(file);
    await fs.writeFile(file, 'inside', 'utf-8');

    expect(await ledger.rollback()).toEqual({ removed: [file, dir], kept: [] });
    expect(await exists(dir)).toBe(false);
  });

  it('does not record a directory that was already there', async () => {
    const ledger = new ScaffoldLedger();
    const dir = path.join(root, 'theirs');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'theirs.txt'), 'theirs', 'utf-8');

    expect(await ledger.mkdir(dir)).toBe(false);

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [] });
    expect(await exists(dir)).toBe(true);
  });

  it('keeps a directory it created once something else lands in it', async () => {
    const ledger = new ScaffoldLedger();
    const dir = path.join(root, 'made');
    const ours = path.join(dir, 'ours.txt');
    const theirs = path.join(dir, 'theirs.txt');

    await ledger.mkdir(dir);
    await ledger.claimFile(ours);
    await fs.writeFile(ours, 'ours', 'utf-8');
    await fs.writeFile(theirs, 'theirs', 'utf-8');

    expect(await ledger.rollback()).toEqual({ removed: [ours], kept: [dir] });
    expect(await fs.readFile(theirs, 'utf-8')).toBe('theirs');
  });

  // ── Directory trees another writer created ───────────────────────────────

  it('prunes a recorded tree once the files inside it are gone', async () => {
    const ledger = new ScaffoldLedger();
    const tree = path.join(root, '.agents');
    const deep = path.join(tree, 'skills', 'a-skill');
    const file = path.join(deep, 'SKILL.md');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(file, 'skill', 'utf-8');

    // Recorded in creation order: tree first, then the file inside it.
    ledger.noteDirTree(tree);
    ledger.noteFile(file);

    expect(await ledger.rollback()).toEqual({ removed: [file, tree], kept: [] });
    expect(await exists(tree)).toBe(false);
  });

  it('keeps the part of a tree that holds a file it did not write', async () => {
    const ledger = new ScaffoldLedger();
    const tree = path.join(root, '.agents');
    const mine = path.join(tree, 'skills', 'mine');
    const theirs = path.join(tree, 'notes');
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(theirs, { recursive: true });
    await fs.writeFile(path.join(theirs, 'theirs.md'), 'theirs', 'utf-8');

    ledger.noteDirTree(tree);

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [tree] });
    // The empty branch went; the one holding their file, and its parent, stayed.
    expect(await exists(mine)).toBe(false);
    expect(await exists(path.join(tree, 'skills'))).toBe(false);
    expect(await fs.readFile(path.join(theirs, 'theirs.md'), 'utf-8')).toBe('theirs');
  });

  it('never follows a symlink out of a tree it is pruning', async () => {
    const ledger = new ScaffoldLedger();
    const outside = path.join(root, 'outside');
    const tree = path.join(root, '.agents');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'precious.txt'), 'precious', 'utf-8');
    await fs.mkdir(tree);
    await fs.symlink(outside, path.join(tree, 'link'));

    ledger.noteDirTree(tree);

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [tree] });
    expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf-8')).toBe('precious');
    expect(await exists(path.join(tree, 'link'))).toBe(true);
  });

  it('reports nothing for a recorded tree that was never created', async () => {
    const ledger = new ScaffoldLedger();

    ledger.noteDirTree(path.join(root, 'never-made'));

    expect(await ledger.rollback()).toEqual({ removed: [], kept: [] });
  });

  it('removes a file another writer reported creating', async () => {
    const ledger = new ScaffoldLedger();
    const file = path.join(root, 'reported.txt');
    await fs.writeFile(file, 'reported', 'utf-8');

    ledger.noteFile(file);

    expect(await ledger.rollback()).toEqual({ removed: [file], kept: [] });
    expect(await exists(file)).toBe(false);
  });

  it('surfaces a permission problem while claiming instead of guessing', async () => {
    const ledger = new ScaffoldLedger();
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked, { mode: 0o000 });

    try {
      await expect(ledger.claimFile(path.join(locked, 'inside.txt'))).rejects.toThrow(/EACCES/);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});
