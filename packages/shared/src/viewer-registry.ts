/**
 * First-party mime/extension → canvas-viewer registry (workbench D7).
 *
 * Maps a file path to the canvas content `type` that should render it, so both
 * the agent's `open_file` command and the client's file explorer resolve a
 * viewer through one shared table. A user-provided `workbench.defaultViewers`
 * override map (from config) takes precedence over the built-in defaults,
 * letting "open CSVs in a different viewer" be a config change, not a code one.
 *
 * Third-party viewer extensibility is intentionally NOT built here — it routes
 * to MCP Apps (ADR 260708-185522); this registry only chooses among the
 * first-party viewers.
 *
 * @module viewer-registry
 */
import type { UiCanvasContent } from './schemas.js';

/**
 * The canvas content shapes a file can open as.
 *
 * Narrowed from {@link UiCanvasContent} to the seven an `open_file` can produce,
 * so a caller that has to branch on the result sees only what it can get.
 */
export type OpenFileCanvasContent = Extract<
  UiCanvasContent,
  { type: 'file' | 'image' | 'pdf' | 'model3d' | 'audio' | 'video' | 'csv' }
>;

/**
 * A canvas viewer a file can resolve to. These map onto `UiCanvasContent`
 * variants: `file` (CodeMirror text/code), `markdown` (Blintz rich editor),
 * `image`, `pdf`, `model3d` (glTF/GLB/STL/OBJ/3MF/PLY/FBX/DAE), `csv`,
 * `audio` (HTML5 `<audio>`), and `video` (HTML5 `<video>`).
 */
export type CanvasViewerType =
  'file' | 'markdown' | 'image' | 'pdf' | 'model3d' | 'csv' | 'audio' | 'video';

/** The set of valid viewer ids, for validating config-supplied override values. */
export const CANVAS_VIEWER_TYPES: readonly CanvasViewerType[] = [
  'file',
  'markdown',
  'image',
  'pdf',
  'model3d',
  'csv',
  'audio',
  'video',
] as const;

/**
 * Built-in extension → viewer mapping. Extensions are lowercase, without the
 * leading dot. Any extension not listed falls back to the CodeMirror `file`
 * viewer, which handles arbitrary text/code (and shows a graceful message for
 * binary content the content route rejects).
 */
const DEFAULT_EXTENSION_VIEWERS: Readonly<Record<string, CanvasViewerType>> = {
  // Markdown → the rich Blintz editor.
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // Raster + vector images.
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'image',
  // PDF.
  pdf: 'pdf',
  // 3D models (served as bytes; rendered by model-viewer / three.js loaders).
  glb: 'model3d',
  gltf: 'model3d',
  stl: 'model3d',
  obj: 'model3d',
  '3mf': 'model3d',
  ply: 'model3d',
  fbx: 'model3d',
  dae: 'model3d',
  // Tabular.
  csv: 'csv',
  tsv: 'csv',
  // Audio (streamed as bytes; rendered by the HTML5 `<audio>` element).
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  // Video (streamed as bytes; rendered by the HTML5 `<video>` element).
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
};

/**
 * Lowercase file extension without the leading dot (e.g. `src/App.TSX` → `tsx`),
 * or `''` when the path has no extension. Dotfiles with no further extension
 * (e.g. `.gitignore`) return `''` so they resolve to the text viewer.
 */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Normalize an override key (strip a leading dot, lowercase) so `.csv`/`csv`/`CSV` all match. */
function normalizeOverrideKey(key: string): string {
  return key.replace(/^\./, '').toLowerCase();
}

/**
 * Resolve which canvas viewer should render a file.
 *
 * Consults the caller-supplied override map first (config
 * `workbench.defaultViewers`), then the built-in defaults, then falls back to
 * the CodeMirror `file` viewer for any unknown extension.
 *
 * @param filePath - Workspace-relative or absolute file path.
 * @param overrides - Optional extension → viewer overrides (config-provided).
 *   Keys may include a leading dot and any case; values are validated against
 *   {@link CANVAS_VIEWER_TYPES} and ignored when invalid.
 */
export function resolveViewerForPath(
  filePath: string,
  overrides?: Record<string, string>
): CanvasViewerType {
  const ext = extensionOf(filePath);
  if (ext === '') return 'file';

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (normalizeOverrideKey(key) === ext && isCanvasViewerType(value)) {
        return value;
      }
    }
  }

  return DEFAULT_EXTENSION_VIEWERS[ext] ?? 'file';
}

/** Type guard: whether a string is a known {@link CanvasViewerType}. */
export function isCanvasViewerType(value: string): value is CanvasViewerType {
  return (CANVAS_VIEWER_TYPES as readonly string[]).includes(value);
}

/**
 * Which diff surface a file resolves to — the text (CodeMirror merge) view or the
 * image (2-up/swipe/onion-skin) view (DOR-212). A file whose viewer is `image`
 * gets the image diff; everything else (code, markdown, csv, and — for v1 — pdf,
 * 3D models, audio, and video, which have no diff surface) gets the text diff,
 * which degrades gracefully for content it can't render as text.
 *
 * @param filePath - Workspace-relative or absolute file path.
 * @param overrides - Optional extension → viewer overrides (config-provided),
 *   consulted exactly as {@link resolveViewerForPath} does.
 */
export function diffMediaKindForPath(
  filePath: string,
  overrides?: Record<string, string>
): 'text' | 'image' {
  return resolveViewerForPath(filePath, overrides) === 'image' ? 'image' : 'text';
}

/**
 * The canvas content one `open_file` produces — viewer resolution and the
 * content it implies, in ONE function.
 *
 * **One implementation, because two writers now open files.** The client's
 * dispatcher resolved the viewer and built the content; since the session canvas
 * moved to the server (spec `canvas-agent-seat` §1.2), an agent's `open_file`
 * is written by the SERVER. Two answers to "what does opening `chart.png` mean"
 * gave two different `sourceKey`s for one file — so one file grew two tabs, and
 * the agent's one opened a text editor on a PNG.
 *
 * Kept beside the registry rather than in either app for the same reason
 * `canvasSourceKey` is: the split is drawn by the viewer table, and a copy of it
 * in an app drifts the moment the table gains a row.
 *
 * @param sourcePath - The file to open, as the caller named it.
 * @param overrides - Extension → viewer overrides (config `workbench.defaultViewers`),
 *   consulted exactly as {@link resolveViewerForPath} does. The SERVER reads them
 *   off the same config the client is handed, so both sides agree.
 * @returns The canvas content for that file.
 */
export function canvasContentForFile(
  sourcePath: string,
  overrides?: Record<string, string>
): OpenFileCanvasContent {
  switch (resolveViewerForPath(sourcePath, overrides)) {
    case 'image':
      return { type: 'image', src: sourcePath };
    case 'pdf':
      return { type: 'pdf', src: sourcePath };
    case 'model3d':
      return { type: 'model3d', src: sourcePath };
    case 'audio':
      return { type: 'audio', src: sourcePath };
    case 'video':
      return { type: 'video', src: sourcePath };
    case 'csv':
      return { type: 'csv', src: sourcePath };
    case 'markdown':
      // Rendered by the file viewer, which loads the bytes and routes markdown
      // to the rich Blintz editor (the `language` hint flags it).
      return { type: 'file', sourcePath, language: 'markdown' };
    case 'file':
      return { type: 'file', sourcePath };
  }
}
