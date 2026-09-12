import { describe, it, expect } from 'vitest';
import {
  resolveViewerForPath,
  isCanvasViewerType,
  diffMediaKindForPath,
  canvasContentForFile,
  CANVAS_VIEWER_TYPES,
} from '../viewer-registry.js';

describe('resolveViewerForPath — built-in defaults', () => {
  it.each([
    ['src/index.ts', 'file'],
    ['README.md', 'markdown'],
    ['docs/notes.mdx', 'markdown'],
    ['assets/logo.png', 'image'],
    ['photo.JPG', 'image'],
    ['diagram.svg', 'image'],
    ['report.pdf', 'pdf'],
    ['model.glb', 'model3d'],
    ['scene.gltf', 'model3d'],
    ['part.stl', 'model3d'],
    ['mesh.obj', 'model3d'],
    ['print.3mf', 'model3d'],
    ['cloud.ply', 'model3d'],
    ['rig.fbx', 'model3d'],
    ['scene.dae', 'model3d'],
    ['track.mp3', 'audio'],
    ['voice.wav', 'audio'],
    ['clip.m4a', 'audio'],
    ['beep.aac', 'audio'],
    ['song.flac', 'audio'],
    ['sound.ogg', 'audio'],
    ['sound.oga', 'audio'],
    ['call.opus', 'audio'],
    ['movie.mp4', 'video'],
    ['screencast.webm', 'video'],
    ['recording.MOV', 'video'],
    ['clip.m4v', 'video'],
    ['loop.ogv', 'video'],
    ['data.csv', 'csv'],
    ['sheet.tsv', 'csv'],
  ] as const)('resolves %s → %s', (path, expected) => {
    expect(resolveViewerForPath(path)).toBe(expected);
  });

  it('falls back to the file viewer for unknown or extension-less paths', () => {
    expect(resolveViewerForPath('Dockerfile')).toBe('file');
    expect(resolveViewerForPath('scripts/build')).toBe('file');
    expect(resolveViewerForPath('.gitignore')).toBe('file');
    expect(resolveViewerForPath('data.xyz')).toBe('file');
  });
});

describe('resolveViewerForPath — config overrides', () => {
  it('lets an override win over the built-in default', () => {
    // Open CSVs in the plain text editor instead of the table viewer.
    expect(resolveViewerForPath('data.csv', { csv: 'file' })).toBe('file');
  });

  it('normalizes override keys (leading dot / case-insensitive)', () => {
    expect(resolveViewerForPath('data.csv', { '.CSV': 'file' })).toBe('file');
  });

  it('ignores an override with an invalid viewer value', () => {
    expect(resolveViewerForPath('data.csv', { csv: 'not-a-viewer' })).toBe('csv');
  });

  it('leaves unrelated extensions on their defaults', () => {
    expect(resolveViewerForPath('logo.png', { csv: 'file' })).toBe('image');
  });
});

describe('isCanvasViewerType', () => {
  it('accepts every registered viewer id', () => {
    for (const viewer of CANVAS_VIEWER_TYPES) {
      expect(isCanvasViewerType(viewer)).toBe(true);
    }
  });

  it('rejects an unknown id', () => {
    expect(isCanvasViewerType('terminal')).toBe(false);
  });
});

describe('diffMediaKindForPath', () => {
  it.each([
    ['assets/logo.png', 'image'],
    ['photo.JPG', 'image'],
    ['diagram.svg', 'image'],
  ])('resolves %s to the image diff surface', (path, kind) => {
    expect(diffMediaKindForPath(path)).toBe(kind);
  });

  it.each([
    ['src/index.ts', 'text'],
    ['README.md', 'text'],
    ['data/rows.csv', 'text'],
    // pdf/3d have no diff surface in v1 → they fall to the text diff, which
    // degrades gracefully rather than inventing a viewer.
    ['report.pdf', 'text'],
    ['model.glb', 'text'],
    ['.gitignore', 'text'],
  ])('resolves %s to the text diff surface', (path, kind) => {
    expect(diffMediaKindForPath(path)).toBe(kind);
  });

  it('honors a viewer override when picking the diff surface', () => {
    // Force a normally-image extension onto the text viewer → text diff.
    expect(diffMediaKindForPath('logo.png', { png: 'file' })).toBe('text');
  });
});

/**
 * The half of viewer resolution that used to live in the client's dispatcher
 * (DOR-2006).
 *
 * It moved here because a second writer appeared: since the session canvas is
 * written by the SERVER, `open_file` is resolved on both sides, and two answers
 * to "what does opening `chart.png` mean" give two `canvasSourceKey`s for one
 * file — one file, two tabs, and the agent's one a text editor loading a PNG.
 * These cases are the ones that were wrong: every non-text viewer.
 */
describe('canvasContentForFile', () => {
  it.each([
    ['assets/logo.png', { type: 'image', src: 'assets/logo.png' }],
    ['report.pdf', { type: 'pdf', src: 'report.pdf' }],
    ['model.glb', { type: 'model3d', src: 'model.glb' }],
    ['tone.mp3', { type: 'audio', src: 'tone.mp3' }],
    ['clip.mp4', { type: 'video', src: 'clip.mp4' }],
    ['data/rows.csv', { type: 'csv', src: 'data/rows.csv' }],
    ['README.md', { type: 'file', sourcePath: 'README.md', language: 'markdown' }],
    ['src/index.ts', { type: 'file', sourcePath: 'src/index.ts' }],
  ])('opens %s as its own viewer, not as text', (path, expected) => {
    expect(canvasContentForFile(path)).toEqual(expected);
  });

  it('honors a viewer override, which is the part a server-only answer dropped', () => {
    // `workbench.defaultViewers` (DOR-219). This states what the RESOLVER does
    // with an override, which is all this package can state: whether each side
    // actually reads the config is a fact about the two callers, and it is
    // asserted where they live — `ui-action-dispatcher.test.ts` ("reads the
    // overrides off the config cache…") and `session-canvas.test.ts` ("applies
    // this install's viewer overrides, read per call"). An earlier version of
    // this comment claimed the symmetry, which this test cannot see.
    expect(canvasContentForFile('logo.png', { png: 'file' })).toEqual({
      type: 'file',
      sourcePath: 'logo.png',
    });
  });

  it('produces one content shape per registered viewer — no viewer falls through', () => {
    // Exhaustiveness the type checker cannot state: every viewer id in the
    // registry must be reachable as a distinct content shape, so a viewer added
    // to the table without an arm here is a compile error, and one added with a
    // wrong arm is this test.
    const byViewer = new Map<string, string>();
    for (const [path, viewer] of [
      ['a.png', 'image'],
      ['a.pdf', 'pdf'],
      ['a.glb', 'model3d'],
      ['a.mp3', 'audio'],
      ['a.mp4', 'video'],
      ['a.csv', 'csv'],
      ['a.md', 'markdown'],
      ['a.ts', 'file'],
    ] as const) {
      expect(resolveViewerForPath(path)).toBe(viewer);
      byViewer.set(viewer, canvasContentForFile(path).type);
    }
    expect([...byViewer.keys()].sort()).toEqual([...CANVAS_VIEWER_TYPES].sort());
  });
});
