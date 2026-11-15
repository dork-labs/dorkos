/**
 * Which Claude Code permission rules a scheduled task may ask for (DOR-3637).
 *
 * A proposer attaches exact rules; a person approves them in one click. So a
 * rule must name one specific action: anything that amounts to a whole tool,
 * the whole home folder, any web domain, or "any command an interpreter runs"
 * is refused before it can reach a card. The home folder is caught by its
 * `~`, `$HOME` and `${HOME}` spellings everywhere, and by its absolute path
 * where the caller passes it (the server does; this module cannot know it).
 *
 * @module permission-rules
 */

/**
 * Programs that run whatever code they are handed. `Bash(python3:*)` or
 * `Bash(sh -c *)` is not one command, it is every command, so a wildcard after
 * one of these is refused (Security Should D-2).
 */
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'python',
  'python2',
  'python3',
  'node',
  'deno',
  'bun',
  'bunx',
  'npx',
  'pnpx',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'pwsh',
  'powershell',
  'env',
  'eval',
  'exec',
  'sudo',
  'xargs',
]);

/** A specifier with nothing left once wildcards, slashes, colons, dots and spaces go. */
function onlyWildcards(specifier: string): boolean {
  return specifier.replace(/[\s*/:.]/g, '').length === 0;
}

/**
 * The specifier with the home folder and doubled leading slashes taken off, so
 * `~/**`, `$HOME/**`, `${HOME}/**`, `//**` and, given `home`, `/Users/sam/**`
 * all read as the broad grants they are.
 */
function normalisePath(specifier: string, home?: string): string {
  let path = specifier
    .trim()
    .replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, '')
    .replace(/^\/{2,}/, '/');
  const root = home?.replace(/\/+$/, '');
  if (root && (path === root || path.startsWith(`${root}/`))) path = path.slice(root.length);
  return path;
}

/** Options for {@link isSpecificPermissionRule}. */
export interface PermissionRuleCheckOptions {
  /** The person's home folder, so its absolute spelling is refused like `~`. */
  home?: string;
}

/**
 * Whether a Claude Code permission rule names one specific action.
 *
 * The shape must be `Tool(specifier)`, with a plain tool name (no `*`, so no
 * `mcp__server__*`) and no control characters. Refused:
 * - a bare tool or empty parentheses;
 * - a specifier that is only wildcards, slashes, colons, dots and spaces, after
 *   the home folder is taken off (`Bash(:*)`, `Read(/**)`, `Read(~/**)`);
 * - a `WebFetch` domain with any wildcard (`domain:*.com`);
 * - a `Bash` rule that hands a wildcard to an interpreter (`Bash(node:*)`).
 *
 * @param rule - The trimmed rule text.
 * @param options - The home folder, when the caller knows it.
 */
export function isSpecificPermissionRule(
  rule: string,
  options: PermissionRuleCheckOptions = {}
): boolean {
  if (/[\p{Cc}\p{Cf}]/u.test(rule)) return false;
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/s.exec(rule);
  if (!match) return false;
  const tool = match[1]!;
  const raw = match[2]!;
  if (tool === 'WebFetch') {
    const domain = raw.trim().replace(/^domain:/, '');
    return !domain.includes('*') && domain.replace(/[\s.]/g, '').length > 0;
  }
  const specifier = normalisePath(raw, options.home);
  if (onlyWildcards(specifier)) return false;
  if (tool === 'Bash' && specifier.includes('*')) {
    const program = specifier.split(/[\s:]/)[0]!.split('/').pop()!;
    if (INTERPRETERS.has(program)) return false;
  }
  return true;
}

/**
 * Whether a rule lets a run start programs, which the approval card always
 * says plainly and confirms separately (Security Should D-2).
 *
 * @param rule - An approved or requested rule.
 */
export function runsPrograms(rule: string): boolean {
  return /^Bash\(/.test(rule.trim());
}

/** Tools whose rules let a run change files. */
const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether a rule lets a run change files outside the task's own folder. A
 * relative path stays in the folder the run starts in; an absolute or home
 * path, a `..` step, or a path into `.git` or `.claude` (hooks and settings,
 * which run code or grant more) reaches past it. The card confirms these
 * separately, as it does a rule that runs programs (review of DOR-3637).
 *
 * @param rule - An approved or requested rule.
 */
export function writesOutsideTaskFolder(rule: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/s.exec(rule.trim());
  if (!match || !FILE_WRITING_TOOLS.has(match[1]!)) return false;
  const path = match[2]!.trim();
  if (/^(?:\/|~|\$HOME|\$\{HOME\})/.test(path)) return true;
  return path.split('/').some((part) => part === '..' || part === '.git' || part === '.claude');
}

/**
 * Whether a rule needs its own confirmation on the card and at the server: it
 * runs programs, or it changes files outside the task's folder.
 *
 * @param rule - An approved or requested rule.
 */
export function needsOwnConfirmation(rule: string): boolean {
  return runsPrograms(rule) || writesOutsideTaskFolder(rule);
}
