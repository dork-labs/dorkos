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
  '.woodpecker.yaml',
  '.woodpecker',
  'appveyor.yml',
  '.appveyor.yml',
  '.semaphore',
  'cloudbuild.yaml',
  'cloudbuild.yml',
]);

/** Keep each decoded spelling without treating a literal percent as a refusal. */
function controlPath(value: string): boolean {
  let decoded = value;
  const candidates = new Set<string>();
  for (;;) {
    candidates.add(decoded);
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
    if (next === decoded) break;
    decoded = next;
  }
  return [...candidates].some((candidate) => controlSpelling(candidate));
}

/** Normalize each spelling from its repository root, including dot segments. */
function controlSpelling(value: string): boolean {
  const parts: string[] = [];
  for (const raw of value.replace(/\\/g, '/').toLowerCase().split('/')) {
    const part = raw.trim();
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
    if (CONTROL_ROOTS.has(parts[0] ?? '') || (parts[0] === 'docs' && parts[1] === 'codeowners'))
      return true;
  }
  return false;
}

/**
 * Inspect nested path arguments, including path lists and legacy multi-file deletes.
 *
 * What it reads, on purpose (DOR-4508): string values under a key whose name
 * contains `path` (and everything nested under such a key), plus `deletes`.
 * File content is never read as a path. `__tests__/workflow-file-keys.test.ts`
 * keeps that honest against a snapshot of every repository write schema: a
 * location-like argument the check doesn't read fails it until it is read or
 * listed there with the reason it isn't a repository file.
 */
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

/** Argument names that replace history when set; any value but an explicit "off" counts. */
const FORCE_KEYS = new Set(['force', 'forcepush']);

/**
 * Argument names that create a branch when given a value. GitLab's
 * `start_sha` and `start_project` start a branch from another commit or
 * project, like `start_branch` (DOR-4507).
 */
const NEW_BRANCH_KEYS = new Set([
  'newbranch',
  'startbranch',
  'basebranch',
  'startsha',
  'startproject',
]);

/** Values that plainly name no branch, commit or project. Anything else fails closed, numbers included. */
function namesNothing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (typeof value === 'string' && value.trim().length === 0)
  );
}

/** Values that plainly leave a force argument off. Anything else fails closed. */
function forceIsOff(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    (typeof value === 'string' && ['', 'false', '0', 'no'].includes(value.trim().toLowerCase()))
  );
}

/** Argument key spelled without case or separators, so `force_push` and `forcePush` match. */
function looseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether nested arguments request history replacement or a new branch. */
export function changesRepositoryHistory(args: Record<string, unknown>): boolean {
  function changes(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(changes);
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => {
      const loose = looseKey(key);
      return (
        (FORCE_KEYS.has(loose) && !forceIsOff(entry)) ||
        (NEW_BRANCH_KEYS.has(loose) && !namesNothing(entry)) ||
        changes(entry)
      );
    });
  }
  return changes(args);
}
