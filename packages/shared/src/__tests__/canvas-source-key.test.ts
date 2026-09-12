/**
 * The dedupe rule, driven over every one of the fourteen canvas content types.
 *
 * It is ONE function rather than two, and that is the point of testing it here:
 * the browser's session canvas and the server's room canvas both import it, so
 * the failure this file exists to prevent — a room silently holding two tabs for
 * one file because two implementations disagreed — cannot happen by drift any
 * more, only by somebody changing this rule on purpose. The case table below is
 * what makes that change visible.
 *
 * @module shared/tests/canvas-source-key
 */
import { describe, it, expect } from 'vitest';
import { canvasSourceKey } from '../canvas-source-key.js';
import { UiCanvasContentSchema, type UiCanvasContent } from '../schemas.js';

/** One case per content variant, with the key it must produce. */
const CASES: Array<{ content: UiCanvasContent; key: string | null }> = [
  { content: { type: 'url', url: 'https://example.test/a' }, key: 'url:https://example.test/a' },
  {
    content: { type: 'browser', url: 'http://localhost:5173/' },
    key: 'browser:http://localhost:5173/',
  },
  {
    content: { type: 'markdown', content: '# hi', sourcePath: 'docs/a.md' },
    key: 'path:docs/a.md',
  },
  { content: { type: 'markdown', content: '# hi' }, key: null },
  { content: { type: 'file', sourcePath: 'src/router.ts' }, key: 'path:src/router.ts' },
  { content: { type: 'diff', sourcePath: 'src/router.ts' }, key: 'diff:src/router.ts' },
  {
    content: { type: 'image', src: 'https://example.test/a.png' },
    key: 'src:https://example.test/a.png',
  },
  {
    content: { type: 'pdf', src: 'https://example.test/a.pdf' },
    key: 'src:https://example.test/a.pdf',
  },
  { content: { type: 'model3d', src: 'model.glb' }, key: 'src:model.glb' },
  { content: { type: 'audio', src: 'track.mp3' }, key: 'src:track.mp3' },
  { content: { type: 'video', src: 'clip.mp4' }, key: 'src:clip.mp4' },
  { content: { type: 'csv', src: 'rows.csv' }, key: 'src:rows.csv' },
  {
    content: { type: 'mcp_app', serverName: 'weather', uri: 'ui://today' },
    key: 'mcp:weather:ui://today',
  },
  { content: { type: 'json', data: { a: 1 } }, key: null },
  { content: { type: 'widget', definition: { version: 1, root: { type: 'divider' } } }, key: null },
];

describe('canvasSourceKey', () => {
  it.each(CASES)('keys $content.type', ({ content, key }) => {
    expect(canvasSourceKey(content)).toBe(key);
  });

  it('covers every variant the schema accepts', () => {
    // The guard that keeps this table honest: a fifteenth content type added to
    // the union without a case here would leave its dedupe rule untested, and
    // the failure mode of an untested dedupe rule is a duplicate tab nobody
    // reports as a bug.
    const declared = new Set(
      UiCanvasContentSchema.options.map((option) => option.shape.type.value as string)
    );
    const covered = new Set(CASES.map((testCase) => testCase.content.type));
    expect([...declared].sort()).toEqual([...covered].sort());
    expect(declared.size).toBe(14);
  });

  it('coalesces a diff on its PATH, so an edit burst refreshes one document', () => {
    expect(canvasSourceKey({ type: 'diff', sourcePath: 'a.ts' })).toBe(
      canvasSourceKey({ type: 'diff', sourcePath: 'a.ts', mediaKind: 'text' })
    );
  });

  it('keeps a file and its diff apart', () => {
    // Same path, two different documents: reviewing a change and reading the
    // file are different things to have open.
    expect(canvasSourceKey({ type: 'file', sourcePath: 'a.ts' })).not.toBe(
      canvasSourceKey({ type: 'diff', sourcePath: 'a.ts' })
    );
  });
});
