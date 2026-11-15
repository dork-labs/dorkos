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
  'codeowners',
  'jenkinsfile',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.travis.yml',
  '.drone.yml',
  '.woodpecker.yml',
  '.woodpecker',
  'appveyor.yml',
  '.semaphore',
  'cloudbuild.yaml',
  'cloudbuild.yml',
]);

/** Keep each decoded spelling without treating a literal percent as a refusal. */
function controlPath(value: string): boolean {
  let decoded = value;
  let malformed = false;
  const candidates = new Set<string>();
  for (;;) {
    candidates.add(decoded);
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      malformed = true;
      next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
    if (next === decoded) break;
    decoded = next;
  }
  return [...candidates].some((candidate) => controlSpelling(candidate, malformed));
}

/** Normalize path segments; malformed prefixes can coexist with encoded separators. */
function controlSpelling(value: string, malformed: boolean): boolean {
  const parts: string[] = [];
  for (const raw of value.replace(/\\/g, '/').toLowerCase().split('/')) {
    const part = raw.trim();
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
    // A malformed prefix cannot hide a control path after its decoded separator.
    if (
      parts.some(
        (entry, index) =>
          (index === 0 || malformed) &&
          (CONTROL_ROOTS.has(entry) || (entry === 'docs' && parts[index + 1] === 'codeowners'))
      )
    )
      return true;
  }
  return false;
}

/** Inspect nested path arguments, including path lists and legacy multi-file deletes. */
function containsControlPath(value: unknown, isPath = false): boolean {
  if (typeof value === 'string') return isPath && controlPath(value);
  if (Array.isArray(value)) return value.some((entry) => containsControlPath(entry, isPath));
  if (value === null || typeof value !== 'object') return false;
  // GitHub's multi-file commit names its deleted-file paths `deletes`, without a path key.
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
