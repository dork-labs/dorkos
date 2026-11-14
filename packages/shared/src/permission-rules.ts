/**
 * Which Claude Code permission rules a scheduled task may ask for (DOR-3637).
 *
 * A proposer attaches exact rules; a person approves them in one click. So a
 * rule must name one specific action: anything that amounts to a whole tool,
 * the whole home folder, any web domain, or "any command an interpreter runs"
 * is refused before it can reach a card.
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
 * `~/**`, `$HOME/**`, `${HOME}/**` and `//**` all read as the broad grants they
 * are.
 */
function normalisePath(specifier: string): string {
  return specifier
    .trim()
    .replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, '')
    .replace(/^\/{2,}/, '/');
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
 */
export function isSpecificPermissionRule(rule: string): boolean {
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
