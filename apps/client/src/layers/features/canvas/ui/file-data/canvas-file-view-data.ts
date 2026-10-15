import type { useCanvasFileSave } from '../../model/use-canvas-file-save';

/**
 * React-query key for a file's loaded content + hash. Shared by the loader, the
 * post-save cache sync (so leaving edit mode shows what was written), and the
 * refresh-from-disk action — one key, one cache entry, no drift.
 */
export function fileContentQueryKey(cwd: string, sourcePath: string) {
  return ['canvas-file', cwd, sourcePath] as const;
}

/** Whether a path (or explicit hint) denotes a markdown document → the rich editor. */
export function isMarkdown(sourcePath: string, language?: string): boolean {
  return language === 'markdown' || /\.(md|markdown|mdx)$/i.test(sourcePath);
}

/** Friendly message for a file-load failure, keyed by the transport's coded error. */
export function loadErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'NOT_FOUND':
      return 'This file doesn’t exist.';
    case 'NOT_A_FILE':
      return 'This path is a directory, not a file.';
    case 'TOO_LARGE':
      return 'This file is too large to open here.';
    case 'BINARY_FILE':
      return 'This file isn’t text, so the editor can’t show it.';
    default:
      return 'This file couldn’t be loaded.';
  }
}

/** The muted save-state line shown next to the edit toggle. */
export function saveStatusLabel(
  status: ReturnType<typeof useCanvasFileSave>['status']
): string | null {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Couldn’t save';
    default:
      return null;
  }
}
