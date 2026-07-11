import { describe, it, expect } from 'vitest';
import {
  DiffBaselineQuerySchema,
  DiffBaselineResponseSchema,
  AdvanceDiffBaselineRequestSchema,
  DiffPendingQuerySchema,
  DiffPendingResponseSchema,
} from '../schemas.js';

describe('DiffBaselineQuerySchema', () => {
  it('defaults mode to "session" when absent', () => {
    const result = DiffBaselineQuerySchema.parse({
      cwd: '/repo',
      path: 'src/App.tsx',
      sessionId: 'sess-1',
    });
    expect(result.mode).toBe('session');
  });

  it('accepts an explicit head mode', () => {
    const result = DiffBaselineQuerySchema.parse({
      cwd: '/repo',
      path: 'src/App.tsx',
      sessionId: 'sess-1',
      mode: 'head',
    });
    expect(result.mode).toBe('head');
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      DiffBaselineQuerySchema.parse({ cwd: '/repo', path: 'a', sessionId: 's', mode: 'index' })
    ).toThrow();
  });

  it('requires a sessionId', () => {
    expect(() => DiffBaselineQuerySchema.parse({ cwd: '/repo', path: 'a' })).toThrow();
  });
});

describe('DiffBaselineResponseSchema', () => {
  it('round-trips a resolved baseline', () => {
    const dto = {
      baseline: 'const a = 1;\n',
      baselineHash: 'abc',
      current: 'const a = 2;\n',
      currentHash: 'def',
      capturedFrom: 'pre-tool' as const,
    };
    expect(DiffBaselineResponseSchema.parse(dto)).toEqual(dto);
  });

  it.each(['pre-tool', 'reconstructed', 'head', 'empty'])('accepts capturedFrom = %s', (origin) => {
    const dto = {
      baseline: '',
      baselineHash: 'h1',
      current: '',
      currentHash: 'h2',
      capturedFrom: origin,
    };
    expect(DiffBaselineResponseSchema.parse(dto).capturedFrom).toBe(origin);
  });

  it('rejects an unknown capturedFrom', () => {
    expect(() =>
      DiffBaselineResponseSchema.parse({
        baseline: '',
        baselineHash: 'h',
        current: '',
        currentHash: 'h',
        capturedFrom: 'git-index',
      })
    ).toThrow();
  });
});

describe('AdvanceDiffBaselineRequestSchema', () => {
  it('round-trips an advance request', () => {
    const dto = { cwd: '/repo', path: 'src/App.tsx', sessionId: 'sess-1' };
    expect(AdvanceDiffBaselineRequestSchema.parse(dto)).toEqual(dto);
  });

  it('requires all three fields', () => {
    expect(() => AdvanceDiffBaselineRequestSchema.parse({ cwd: '/repo', path: 'a' })).toThrow();
  });
});

describe('DiffPendingSchemas', () => {
  it('round-trips a pending query', () => {
    const dto = { cwd: '/repo', sessionId: 'sess-1' };
    expect(DiffPendingQuerySchema.parse(dto)).toEqual(dto);
  });

  it('round-trips a pending response', () => {
    const dto = { files: ['src/App.tsx', 'src/main.ts'] };
    expect(DiffPendingResponseSchema.parse(dto)).toEqual(dto);
  });

  it('defaults to an empty file list shape only when provided', () => {
    expect(DiffPendingResponseSchema.parse({ files: [] })).toEqual({ files: [] });
  });
});
