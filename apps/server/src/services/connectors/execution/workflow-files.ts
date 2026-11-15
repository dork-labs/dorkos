/** Argument-sensitive repository-control changes require the agent's own exact grant. */

const CONTROL_ROOTS = new Set([
  '.github',
  '.gitlab-ci.yml',
  '.gitlab',
  '.gitea',
  '.forgejo',
  'bitbucket-pipelines.yml',
  '.circleci',
  '.buildkite',
]);

/** Decode first: malformed paths cannot qualify for an access level. */
function controlPath(value: string): boolean {
  let decoded = value;
  try {
    for (;;) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return true;
  }
  const parts: string[] = [];
  for (const raw of decoded.replace(/\\/g, '/').toLowerCase().split('/')) {
    const part = raw.trim();
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
    // A path entering a control root stays explicit even if later segments back out.
    if (CONTROL_ROOTS.has(parts[0] ?? '')) return true;
  }
  return false;
}

/** Inspect nested path arguments, including path lists and legacy multi-file deletes. */
function containsControlPath(value: unknown, isPath = false): boolean {
  if (typeof value === 'string') return isPath && controlPath(value);
  if (Array.isArray(value)) return value.some((entry) => containsControlPath(entry, isPath));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    containsControlPath(entry, isPath || /path/i.test(key) || key === 'deletes')
  );
}

/**
 * Whether any action's arguments name repository controls, regardless of its toolkit.
 *
 * @param args - Arguments before schema validation and execution.
 */
export function changesRepositoryControlFiles(args: Record<string, unknown>): boolean {
  return containsControlPath(args);
}
