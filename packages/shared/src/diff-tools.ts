/**
 * Edit-family tool classification for the diff-review surface (DOR-212).
 *
 * Shared by the server's baseline capture (pre-tool boundary) and the client's
 * auto-open subscriber so both agree on exactly which tools mutate a file and
 * how to read the target path from the tool input — one source of truth, no drift.
 *
 * @module diff-tools
 */

/**
 * Claude Code tools that write a file's contents. These are the tools whose
 * pre-image DorkOS snapshots for the diff base, and whose completed `tool_call`
 * events trigger the auto-open diff.
 */
export const EDIT_FAMILY_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** Whether a tool name is an edit-family (file-mutating) tool. */
export function isEditFamilyTool(toolName: string): boolean {
  return EDIT_FAMILY_TOOLS.has(toolName);
}

/**
 * Read the target file path from an edit-family tool's input, or `null` when it
 * carries none. `Edit`/`Write`/`MultiEdit` use `file_path`; `NotebookEdit` uses
 * `notebook_path`.
 *
 * @param input - The tool's parsed input object.
 */
export function editToolFilePath(input: Record<string, unknown>): string | null {
  const filePath = input.file_path ?? input.notebook_path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}
