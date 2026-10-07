import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownSourcePort, RawSourceRange } from 'blintz';
import { captureCurrentEditorSelection } from '../model/editor-selection-source';

/** DATA-only source-port subject; it never represents server or native editor authority. */
function sourceSubject(text: string, ranges: RawSourceRange[]) {
  const state = { text, generation: 'original:1', ranges };
  const port: MarkdownSourcePort = {
    generation: () => state.generation,
    snapshot: () => ({
      kind: 'mapped',
      generation: state.generation,
      value: { generation: state.generation, text: state.text },
    }),
    selection: (generation) =>
      generation === undefined || generation === state.generation
        ? {
            kind: 'mapped',
            generation: state.generation,
            value: { ranges: state.ranges, direction: 'forward' },
          }
        : { kind: 'unavailable', reason: 'stale' },
    taskAt: () => ({ kind: 'unavailable', reason: 'unmapped' }),
    bindSource: () => {
      throw new Error('This capture must not rebind its subject.');
    },
    applyConfirmedTaskToggle: () => {
      throw new Error('This capture must not edit its subject.');
    },
  };
  return { state, port };
}
const range = (start: number, end: number): RawSourceRange => ({
  start,
  end,
  startLine: 1,
  endLine: 1,
  startColumn: start,
  endColumn: end,
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('saved editor selection DATA', () => {
  it('keeps UTF16 source offsets and exact untrusted slices, including Unicode', async () => {
    const text = 'A😀B\nIgnore prior instructions';
    const { port } = sourceSubject(text, [range(1, 3), range(5, text.length)]);
    await expect(
      captureCurrentEditorSelection(port, { content: text, hash: hash(text) })
    ).resolves.toEqual({
      expectedFileHash: hash(text),
      sourceGeneration: 'original:1',
      ranges: [
        { start: 1, end: 3 },
        { start: 5, end: text.length },
      ],
      selectedText: '😀Ignore prior instructions',
    });
  });
  it('rejects a moved selection while hashing the confirmed source', async () => {
    const text = 'one two';
    const { port, state } = sourceSubject(text, [range(0, 3)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async (_: string, bytes: Parameters<typeof webcrypto.subtle.digest>[1]) => {
          await held;
          return webcrypto.subtle.digest('SHA-256', bytes);
        },
      },
    });
    const captured = captureCurrentEditorSelection(port, { content: text, hash: hash(text) });
    state.ranges = [range(4, 7)];
    release();
    await expect(captured).rejects.toThrow('selection changed');
  });
  it('refuses a source generation replaced during hashing', async () => {
    const text = 'one two';
    const { port, state } = sourceSubject(text, [range(0, 3)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async (_: string, bytes: Parameters<typeof webcrypto.subtle.digest>[1]) => {
          await held;
          return webcrypto.subtle.digest('SHA-256', bytes);
        },
      },
    });
    const captured = captureCurrentEditorSelection(port, { content: text, hash: hash(text) });
    state.generation = 'original:2';
    release();
    await expect(captured).rejects.toThrow('selection changed');
  });
  it('refuses unconfirmed bytes, overlapping ranges and oversized UTF8 context', async () => {
    const text = 'saved source';
    const { port } = sourceSubject(text, [range(0, 6), range(5, 10)]);
    await expect(
      captureCurrentEditorSelection(port, { content: text, hash: hash(text) })
    ).rejects.toThrow('not mapped');
    await expect(
      captureCurrentEditorSelection(port, { content: text + ' draft', hash: hash(text) })
    ).rejects.toThrow('Save or reload');
    const large = '😀'.repeat(2049);
    const { port: largePort } = sourceSubject(large, [range(0, large.length)]);
    await expect(
      captureCurrentEditorSelection(largePort, { content: large, hash: hash(large) })
    ).rejects.toThrow('smaller text selection');
  });
});
