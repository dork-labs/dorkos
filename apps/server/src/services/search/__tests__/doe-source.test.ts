import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { projectDoeMessages } from '../projections/doe.js';
import { openDoeSnapshot } from '../doe-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { createDoeSource } from '../registry.js';
import { sweepSnapshotSource } from '../snapshot-frontier.js';

describe('DorkOS search prose boundaries', () => {
  it.each(['text', 'input_text', 'output_text'])(
    'reads %s text without reasoning, tool arguments or image fields',
    (type) => {
      const result = projectDoeMessages('one', [
        {
          seq: 7,
          payload: JSON.stringify({
            role: 'assistant',
            content: [
              { type, text: 'searchable' },
              { type: 'thinking', thinking: 'private' },
              { type: 'toolCall', arguments: { secret: 'private' } },
              { type: 'image', data: 'private' },
            ],
            reasoning: 'private',
          }),
        },
      ]);
      expect(result.messages).toEqual([
        {
          originKey: 'one',
          ordinal: 7,
          messageId: null,
          role: 'assistant',
          createdAt: null,
          body: 'searchable',
        },
      ]);
    }
  );
  it('reads ordinary user strings and drops tool role and malformed rows', () => {
    const result = projectDoeMessages('one', [
      { seq: 1, payload: '{' },
      { seq: 2, payload: JSON.stringify({ role: 'toolResult', content: 'private' }) },
      { seq: 3, payload: JSON.stringify({ role: 'user', content: 'hello' }) },
    ]);
    expect(result.skipped).toBe(1);
    expect(result.messages.map((message) => message.body)).toEqual(['hello']);
  });
  it('snapshots only tracked main conversations, keeps the live store untouched, and discovers removal', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'doe-search-test-'));
    const metadata = new Database(path.join(directory, 'sessions.sqlite'));
    const models = new Database(path.join(directory, 'models.sqlite'));
    try {
      metadata.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,record TEXT)');
      models.exec('CREATE TABLE messages(session_id TEXT,scope TEXT,seq INTEGER,payload TEXT)');
      metadata
        .prepare('INSERT INTO sessions VALUES (?,?)')
        .run('one', JSON.stringify({ session: { cwd: '/workspace' } }));
      const add = models.prepare('INSERT INTO messages VALUES (?,?,?,?)');
      for (const scope of ['main', 'child:two', 'beat:three'])
        add.run('one', scope, 1, JSON.stringify({ role: 'user', content: scope }));
      add.run('untracked', 'main', 1, JSON.stringify({ role: 'user', content: 'private' }));
      let snapshot = openDoeSnapshot(directory)!;
      expect(snapshot.listContainers()).toEqual([
        { originKey: 'one', containerPath: '/workspace', maxOrdinal: 1 },
      ]);
      expect(snapshot.readSince('one', 0).messages.map((message) => message.body)).toEqual([
        'main',
      ]);
      expect(snapshot.readSince('untracked', 0).messages).toEqual([]);
      snapshot.close();
      const index = createTestDb();
      try {
        metadata
          .prepare('INSERT INTO sessions VALUES (?,?)')
          .run('kept', JSON.stringify({ session: {} }));
        const source = createDoeSource(() => directory);
        await sweepSnapshotSource(index, source, '2026-10-08T10:00:00Z');
        expect(
          index.$client.prepare("SELECT body FROM messages WHERE source_id='doe'").all()
        ).toEqual([{ body: 'main' }]);
        metadata.exec("DELETE FROM sessions WHERE id='one'");
        await sweepSnapshotSource(index, source, '2026-10-08T10:01:00Z');
        await sweepSnapshotSource(index, source, '2026-10-08T10:02:00Z');
        expect(
          index.$client.prepare("SELECT body FROM messages WHERE source_id='doe'").all()
        ).toEqual([]);
      } finally {
        index.$client.close();
      }
      snapshot = openDoeSnapshot(directory)!;
      expect(snapshot.listContainers()).toEqual([
        { originKey: 'kept', containerPath: null, maxOrdinal: 0 },
      ]);
      snapshot.close();
      expect(models.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 4 });
    } finally {
      metadata.close();
      models.close();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(openDoeSnapshot(directory)).toBeNull();
  });
});
