/** Identify the existing file-content cache by its working directory and source path. */
export function fileContentQueryKey(cwd: string, sourcePath: string) {
  return ['canvas-file', cwd, sourcePath] as const;
}
