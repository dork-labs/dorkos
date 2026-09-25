import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../index';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Purpose: every connection `createDb` opens zeroes what it deletes, so a Community message
 * replaced after an erasure or a takedown does not linger in the database file
 * (specs/community-member-erasure task 2.1). It fails if the house pragma is dropped: the row
 * below is written, grown past its page, and deleted, and without `secure_delete` the old text is
 * still in the file afterwards — both in the freed cell and in the page a split rebuilt.
 */
describe('createDb secure_delete', () => {
  it('leaves no deleted text in the database file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'secure-delete-'));
    directories.push(directory);
    const file = join(directory, 'dork.db');
    const db = createDb(file);
    const raw = db.$client;
    expect(raw.pragma('secure_delete', { simple: true })).toBe(1);

    raw.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const insert = raw.prepare('INSERT INTO notes (body) VALUES (?)');
    insert.run('zqxsecuretoken was said here');
    // Enough rows to split the first leaf, so the old page is rebuilt as well as freed.
    for (let index = 0; index < 200; index++) insert.run(`filler row ${index} ${'x'.repeat(64)}`);
    raw.prepare("UPDATE notes SET body = 'replaced' WHERE body LIKE 'zqx%'").run();
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();

    expect(readFileSync(file).toString('latin1')).not.toContain('zqxsecuretoken');
  });
});
