import { describe, it, expect } from 'vitest';
import { mockCanvasDocument } from '@dorkos/test-utils';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { roomDocumentReading } from '../lib/room-canvas-reading';

/** One document on a room's table. */
function doc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return mockCanvasDocument(overrides);
}

describe('roomDocumentReading — what travelled with the row', () => {
  it('draws every shape that carries its own content', () => {
    const shapes: CanvasDocument['content'][] = [
      { type: 'markdown', content: '# Hi' },
      { type: 'json', data: {} },
      { type: 'url', url: 'https://dorkos.ai' },
      { type: 'browser', url: 'https://dorkos.ai' },
      { type: 'widget', definition: { kind: 'stack' } as never },
      { type: 'mcp_app', serverName: 's', uri: 'ui://x' },
      { type: 'image', src: 'https://dorkos.ai/a.png' },
      { type: 'csv', src: 'data:text/csv,a,b' },
    ];
    for (const content of shapes) {
      expect(roomDocumentReading(doc({ content }))).toEqual({ kind: 'inline' });
    }
  });
});

describe('roomDocumentReading — a document that names a file', () => {
  it('reads a text file in the room’s own copy through the room’s files', () => {
    const reading = roomDocumentReading(
      doc({ content: { type: 'file', sourcePath: 'src/a.ts' }, treeKind: 'room-main' })
    );
    expect(reading).toEqual({ kind: 'room-file', sourcePath: 'src/a.ts' });
  });

  it('treats a path with no tree recorded as the room’s own files', () => {
    // What a person's own open through the Files section produces: the request
    // carries no working directory, so the row records no tree, and the only
    // files a person browses in a room are the room's own.
    const reading = roomDocumentReading(doc({ content: { type: 'file', sourcePath: 'ROOM.md' } }));
    expect(reading).toEqual({ kind: 'room-file', sourcePath: 'ROOM.md' });
  });

  it('refuses a file in another member’s working copy, and names whose it is', () => {
    const reading = roomDocumentReading(
      doc({
        content: { type: 'file', sourcePath: 'draft.ts' },
        treeKind: 'worktree',
        sourceLabel: 'Ana’s copy · 3 ahead of main',
      })
    );
    expect(reading.kind).toBe('elsewhere');
    expect(reading.kind === 'elsewhere' && reading.sentence).toContain('Ana');
    expect(reading.kind === 'elsewhere' && reading.sentence).toContain('can’t open from here');
  });

  it('refuses a file in somebody’s own project in a room with no files of its own', () => {
    const reading = roomDocumentReading(
      doc({
        content: { type: 'diff', sourcePath: 'app.ts' },
        treeKind: 'agent-cwd',
        sourceLabel: 'in Kai’s project',
      })
    );
    expect(reading.kind === 'elsewhere' && reading.sentence).toContain('Kai');
  });

  it('says "another member" rather than guessing when no label was recorded', () => {
    const reading = roomDocumentReading(
      doc({ content: { type: 'file', sourcePath: 'x.ts' }, treeKind: 'worktree' })
    );
    expect(reading.kind === 'elsewhere' && reading.sentence).toContain('another member');
  });

  it('still draws markdown read out of a tree it cannot reach — the text came with the row', () => {
    const reading = roomDocumentReading(
      doc({
        content: { type: 'markdown', content: '# Notes', sourcePath: 'notes.md' },
        treeKind: 'worktree',
        sourceLabel: 'Ana’s copy',
      })
    );
    expect(reading).toEqual({ kind: 'inline' });
  });

  it('sends a local-path picture to the card, because the files route answers text', () => {
    const reading = roomDocumentReading(
      doc({ content: { type: 'image', src: 'docs/logo.png' }, treeKind: 'room-main' })
    );
    expect(reading.kind).toBe('elsewhere');
    expect(reading.kind === 'elsewhere' && reading.sentence).toContain('Files section');
  });
});
