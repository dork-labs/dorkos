/** Argument-sensitive GitHub file changes that require the agent's own exact grant. */

/** Whether a path names a workflow file, accepting the catalog's path spellings. */
function workflowPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts: string[] = [];
  for (const part of value.toLowerCase().split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').startsWith('.github/workflows/');
}

function paths(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry: unknown) =>
    entry !== null && typeof entry === 'object' && 'path' in entry ? entry.path : undefined
  );
}

/**
 * Whether this GitHub operation changes any workflow path.
 *
 * @param operation - The catalog action being run.
 * @param args - Its arguments, before schema validation and execution.
 */
export function changesWorkflowFiles(
  operation: { toolkit: string; operationSlug: string },
  args: Record<string, unknown>
): boolean {
  if (operation.toolkit.toLowerCase() !== 'github') return false;
  const slug = operation.operationSlug.replace(/[^a-z0-9]/gi, '').toUpperCase();
  switch (slug) {
    case 'GITHUBCREATEORUPDATEFILECONTENTS':
    case 'GITHUBDELETEAFILE':
      return workflowPath(args.path);
    case 'GITHUBCREATEATREE':
      return paths(args.tree).some(workflowPath);
    case 'GITHUBCOMMITMULTIPLEFILES':
      return [...paths(args.upserts), ...(Array.isArray(args.deletes) ? args.deletes : [])].some(
        workflowPath
      );
    default:
      return false;
  }
}
