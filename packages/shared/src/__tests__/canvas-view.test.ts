import { describe, it, expect } from 'vitest';
import type { UiCanvasContent } from '../schemas.js';
import { canvasViewForContent, type CanvasView } from '../canvas-view.js';

/**
 * The view every content type belongs to, stated once.
 *
 * Typed as a total `Record` over the union on purpose: adding a fifteenth canvas
 * content type fails the typecheck here until somebody decides which tab renders
 * it, which is the only thing standing between this split and the viewer
 * dispatch in `CanvasViews.tsx` drifting apart.
 */
const EXPECTED: Record<UiCanvasContent['type'], CanvasView> = {
  url: 'browser',
  browser: 'browser',
  markdown: 'canvas',
  json: 'canvas',
  image: 'canvas',
  pdf: 'canvas',
  widget: 'canvas',
  // An app, not a page: it has its own viewer and its own `mcp:<server>:<uri>`
  // identity, so it falls out of the rule rather than being an exception to it.
  mcp_app: 'canvas',
  file: 'canvas',
  model3d: 'canvas',
  audio: 'canvas',
  video: 'canvas',
  csv: 'canvas',
  diff: 'canvas',
};

/** A minimal content value of each type, enough for the view rule to read. */
const SAMPLES: Record<UiCanvasContent['type'], UiCanvasContent> = {
  url: { type: 'url', url: 'https://a.test/' },
  browser: { type: 'browser', url: 'https://a.test/' },
  markdown: { type: 'markdown', content: '# hi' },
  json: { type: 'json', data: {} },
  image: { type: 'image', src: 'a.png' },
  pdf: { type: 'pdf', src: 'a.pdf' },
  widget: { type: 'widget', definition: { version: 1, root: { type: 'text', text: 'x' } } },
  mcp_app: { type: 'mcp_app', serverName: 'srv', uri: 'ui://a' },
  file: { type: 'file', sourcePath: 'a.ts' },
  model3d: { type: 'model3d', src: 'a.glb' },
  audio: { type: 'audio', src: 'a.mp3' },
  video: { type: 'video', src: 'a.mp4' },
  csv: { type: 'csv', src: 'a.csv' },
  diff: { type: 'diff', sourcePath: 'a.ts' },
};

describe('canvasViewForContent', () => {
  it('sends exactly the two types the embedded browser renders to the Browser view', () => {
    const byView = Object.entries(SAMPLES).map(
      ([type, content]) => [type, canvasViewForContent(content)] as const
    );
    expect(Object.fromEntries(byView)).toEqual(EXPECTED);
  });

  it('keeps every other type — mcp_app included — in the Canvas view', () => {
    const browserTypes = Object.entries(SAMPLES)
      .filter(([, content]) => canvasViewForContent(content) === 'browser')
      .map(([type]) => type);
    expect(browserTypes.sort()).toEqual(['browser', 'url']);
  });
});
