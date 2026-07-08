import { describe, it, expect } from 'vitest';
import {
  FileEntrySchema,
  FileTreeQuerySchema,
  FileTreeResponseSchema,
  FileContentQuerySchema,
  FileContentResponseSchema,
  CreateEntryRequestSchema,
  CreateEntryResponseSchema,
  DeleteEntryQuerySchema,
  RenameEntryRequestSchema,
  FileMutationResponseSchema,
} from '../schemas.js';

// The workbench file-service DTOs are the contract between the server routes and
// both Transport implementations, so their round-trips (and the query-string
// coercions Express relies on) are the load-bearing invariants to lock down.

describe('FileEntrySchema', () => {
  it('round-trips a file entry', () => {
    const entry = {
      name: 'index.ts',
      path: 'src/index.ts',
      type: 'file' as const,
      size: 1234,
      mtime: 1_700_000_000_000,
      isSymlink: false,
    };
    expect(FileEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects an unknown entry type', () => {
    expect(() =>
      FileEntrySchema.parse({
        name: 'x',
        path: 'x',
        type: 'symlink',
        size: 0,
        mtime: 0,
        isSymlink: true,
      })
    ).toThrow();
  });
});

describe('FileTreeQuerySchema', () => {
  it('defaults depth to 1 and showHidden to false when omitted', () => {
    const parsed = FileTreeQuerySchema.parse({ cwd: '/w' });
    expect(parsed).toEqual({ cwd: '/w', depth: 1, showHidden: false });
  });

  it('coerces string query params (depth, showHidden) from Express', () => {
    // Express delivers query params as strings — coercion must survive that.
    const parsed = FileTreeQuerySchema.parse({
      cwd: '/w',
      path: 'src',
      depth: '3',
      showHidden: 'true',
    });
    expect(parsed).toEqual({ cwd: '/w', path: 'src', depth: 3, showHidden: true });
  });

  it('rejects depth below 1 and above the cap', () => {
    expect(() => FileTreeQuerySchema.parse({ cwd: '/w', depth: '0' })).toThrow();
    expect(() => FileTreeQuerySchema.parse({ cwd: '/w', depth: '99' })).toThrow();
  });

  it('requires a non-empty cwd', () => {
    expect(() => FileTreeQuerySchema.parse({ cwd: '' })).toThrow();
  });
});

describe('FileTreeResponseSchema', () => {
  it('round-trips an entries array', () => {
    const res = {
      entries: [
        { name: 'a', path: 'a', type: 'dir' as const, size: 0, mtime: 1, isSymlink: false },
      ],
    };
    expect(FileTreeResponseSchema.parse(res)).toEqual(res);
  });
});

describe('FileContentQuerySchema / FileContentResponseSchema', () => {
  it('round-trips the query', () => {
    const q = { cwd: '/w', path: 'README.md' };
    expect(FileContentQuerySchema.parse(q)).toEqual(q);
  });

  it('round-trips the response and pins encoding to utf-8', () => {
    const res = { content: 'hello', hash: 'abc', encoding: 'utf-8' as const };
    expect(FileContentResponseSchema.parse(res)).toEqual(res);
  });

  it('rejects a non-utf-8 encoding literal', () => {
    expect(() =>
      FileContentResponseSchema.parse({ content: '', hash: 'x', encoding: 'latin1' })
    ).toThrow();
  });
});

describe('CreateEntryRequestSchema / CreateEntryResponseSchema', () => {
  it('round-trips a file create with content', () => {
    const req = { cwd: '/w', path: 'a.txt', type: 'file' as const, content: 'x' };
    expect(CreateEntryRequestSchema.parse(req)).toEqual(req);
  });

  it('allows a dir create without content', () => {
    const req = { cwd: '/w', path: 'a', type: 'dir' as const };
    expect(CreateEntryRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects an unknown entry type', () => {
    expect(() =>
      CreateEntryRequestSchema.parse({ cwd: '/w', path: 'a', type: 'symlink' })
    ).toThrow();
  });

  it('round-trips the response', () => {
    const res = { ok: true as const, path: 'a.txt' };
    expect(CreateEntryResponseSchema.parse(res)).toEqual(res);
  });
});

describe('DeleteEntryQuerySchema', () => {
  it('defaults recursive to false and coerces the string flag', () => {
    expect(DeleteEntryQuerySchema.parse({ cwd: '/w', path: 'a' })).toEqual({
      cwd: '/w',
      path: 'a',
      recursive: false,
    });
    expect(DeleteEntryQuerySchema.parse({ cwd: '/w', path: 'a', recursive: 'true' })).toEqual({
      cwd: '/w',
      path: 'a',
      recursive: true,
    });
  });

  it('requires a non-empty path', () => {
    expect(() => DeleteEntryQuerySchema.parse({ cwd: '/w', path: '' })).toThrow();
  });
});

describe('RenameEntryRequestSchema / FileMutationResponseSchema', () => {
  it('round-trips a rename request', () => {
    const req = { cwd: '/w', from: 'a.txt', to: 'b.txt' };
    expect(RenameEntryRequestSchema.parse(req)).toEqual(req);
  });

  it('requires both from and to', () => {
    expect(() => RenameEntryRequestSchema.parse({ cwd: '/w', from: 'a.txt' })).toThrow();
  });

  it('round-trips the mutation response', () => {
    expect(FileMutationResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });
});
