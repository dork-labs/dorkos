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

/**
 * A canvas viewer a file can resolve to. These map onto `UiCanvasContent`
 * variants: `file` (CodeMirror text/code), `markdown` (Blintz rich editor),
 * `image`, `pdf`, `model3d` (glTF/GLB/STL/OBJ), and `csv`.
 */
export type CanvasViewerType = 'file' | 'markdown' | 'image' | 'pdf' | 'model3d' | 'csv';

/** The set of valid viewer ids, for validating config-supplied override values. */
export const CANVAS_VIEWER_TYPES: readonly CanvasViewerType[] = [
  'file',
  'markdown',
  'image',
  'pdf',
  'model3d',
  'csv',
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
  // Tabular.
  csv: 'csv',
  tsv: 'csv',
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
