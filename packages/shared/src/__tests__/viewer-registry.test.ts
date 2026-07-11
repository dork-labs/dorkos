import { describe, it, expect } from 'vitest';
import {
  resolveViewerForPath,
  isCanvasViewerType,
  diffMediaKindForPath,
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
