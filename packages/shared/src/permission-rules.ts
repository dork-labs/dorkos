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

/**
 * Characters that make a path rule a pattern rather than one path. `\` is in
 * the set: gitignore-style matching reads it as an escape (`.gi\t` is `.git`),
 * and Windows reads it as a separator, so it is never taken at face value.
 */
const GLOB = /[*?[{\\]/;

/** The home spellings a rule may start with. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/;

/** A path that starts at a root: `/`, `\`, or a drive letter. */
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** Tools whose rules let a run change files. */
const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A rule split into its tool and the text between the parentheses. */
function parseRule(rule: string): { tool: string; spec: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/s.exec(rule.trim());
  return match ? { tool: match[1]!, spec: match[2]!.trim() } : null;
}

/**
 * A specifier with nothing left once wildcards, slashes, colons, dots and
 * spaces go. Claude Code's path rules are gitignore-style patterns, so `?`,
 * `[...]`, `{...}`, `!` and `\` count as wildcards too.
 */
function onlyWildcards(specifier: string): boolean {
  return specifier.replace(/[\s*/:.?[\]{}!\\]/g, '').length === 0;
}

/**
 * The specifier with the home folder and doubled leading slashes taken off, so
 * `~/**`, `$HOME/**`, `${HOME}/**` and `//**` all read as the broad grants
 * they are.
 */
function normalisePath(specifier: string): string {
  return specifier
    .trim()
    .replace(HOME_PREFIX, '')
    .replace(/^\/{2,}/, '/');
}

/**
 * One spelling for a folder path, so two spellings of the same folder compare
 * equal: `\` read as `/`, doubled slashes collapsed, `.` and `..` resolved,
 * case folded (the default macOS and Windows disks ignore case), a drive letter
 * dropped, and macOS's other names for the root (`/System/Volumes/Data`,
 * `/Volumes/<disk>`) read as `/`. A `..` that climbs past the root stays at it.
 */
function canonicalFolder(path: string): string {
  const parts: string[] = [];
  const text = path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:(?=\/)/, '')
    .toLowerCase();
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  let canonical = `/${parts.join('/')}`;
  canonical = canonical.replace(/^\/system\/volumes\/data(?=\/|$)/, '');
  canonical = canonical.replace(/^\/volumes\/[^/]+(?=\/|$)/, '');
  return canonical || '/';
}

/**
 * Whether a path rule reaches the whole home folder, or a folder above it
 * (`//Users/**`, `/**`, `//users/sa?/**`, `C:\Users\**`). The fixed part
 * before the first pattern character names a folder; when that folder is home
 * or one of its parents, compared in {@link canonicalFolder}'s one spelling,
 * the rule can match everything in home. A `..` after a pattern character
 * cannot be resolved, so it counts as reaching the root. A Windows home
 * (`C:\\Users\\sam`) is compared the same way.
 */
function coversHome(specifier: string, home: string): boolean {
  const root = canonicalFolder(home);
  // Claude Code on Windows reads \ as a separator; elsewhere it is an escape,
  // so it stays a pattern character (and the fixed part stops before it).
  const windows = /^[A-Za-z]:|\\/.test(home);
  const typed = specifier.trim().replace(HOME_PREFIX, home);
  const path = windows ? typed.replace(/\\/g, '/') : typed;
  if (!ABSOLUTE.test(path)) return false;
  const glob = path.search(GLOB);
  const tail = glob === -1 ? '' : path.slice(glob);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(tail)) return true;
  const fixed = glob === -1 ? path : path.slice(0, glob);
  // With a pattern after it, the last fixed segment is only part of a name.
  const folder = canonicalFolder(glob === -1 ? fixed : fixed.replace(/[^\\/]*$/, ''));
  return folder === '/' || root === folder || root.startsWith(`${folder}/`);
}

/** Options for {@link isSpecificPermissionRule}. */
export interface PermissionRuleCheckOptions {
  /** The person's home folder, so a rule reaching it or a parent is refused. */
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
 * - a `Bash` rule that hands a wildcard to an interpreter (`Bash(node:*)`);
 * - given `home`, a path rule that reaches all of home or a parent of it, in
 *   any spelling of that folder.
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
  const specifier = normalisePath(raw);
  if (onlyWildcards(specifier)) return false;
  if (tool !== 'Bash' && options.home && coversHome(raw, options.home)) return false;
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

/**
 * Whether a file rule reaches past the folder the run starts in, judged by its
 * shape rather than by listing bad spellings: an absolute or home path, a
 * `..` step, or any pattern character (`* ? [ { \`), which can match anything,
 * `.git` included, under any case or escape. A relative path with none of
 * those names one file inside the folder, except one into `.git` or `.claude`
 * (hooks and settings, which run code or grant more), compared without case.
 */
function reachesPastTaskFolder(spec: string): boolean {
  if (HOME_PREFIX.test(spec) || ABSOLUTE.test(spec) || GLOB.test(spec)) return true;
  return spec.split('/').some((part) => ['..', '.git', '.claude'].includes(part.toLowerCase()));
}

/**
 * Whether a rule lets a run change files outside the task's own folder, or
 * may (see {@link reachesPastTaskFolder}). The card confirms these separately,
 * as it does a rule that runs programs (review of DOR-3637).
 *
 * @param rule - An approved or requested rule.
 */
export function writesOutsideTaskFolder(rule: string): boolean {
  const parsed = parseRule(rule);
  return !!parsed && FILE_WRITING_TOOLS.has(parsed.tool) && reachesPastTaskFolder(parsed.spec);
}

/**
 * Whether a Read rule can reach far more than it seems to name: a pattern
 * over an absolute or home path (`Read(//users/sam/**)`), or any path with a
 * `..` step (`Read(../../../sam/**)`), which climbs out of the task's folder
 * as an edit rule's would. A named absolute file stays one click; these take
 * the separate yes.
 *
 * @param rule - An approved or requested rule.
 */
export function readsBroadly(rule: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== 'Read') return false;
  if (parsed.spec.split(/[\\/]/).includes('..')) return true;
  const rooted = HOME_PREFIX.test(parsed.spec) || ABSOLUTE.test(parsed.spec);
  return rooted && GLOB.test(parsed.spec);
}

/**
 * Whether a rule needs its own confirmation on the card and at the server: it
 * runs programs, changes files outside the task's folder, or reads by a
 * pattern over an absolute or home path.
 *
 * @param rule - An approved or requested rule.
 */
export function needsOwnConfirmation(rule: string): boolean {
  return runsPrograms(rule) || writesOutsideTaskFolder(rule) || readsBroadly(rule);
}
