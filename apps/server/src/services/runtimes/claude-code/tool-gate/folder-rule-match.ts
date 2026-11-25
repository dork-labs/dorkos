/**
 * How the folder-settings check reads one rule against one call (`folder-file-allows.ts`,
 * DOR-5237). Two questions, each answered on the side that only ever adds a card:
 *
 * - {@link ruleMayAllow}: could this rule let this call run? Read generously, by tool name and
 *   tool family.
 * - {@link ruleCovers}: does a vouched rule already let this exact call run? Read narrowly; a
 *   command with any shell syntax in it is never covered.
 *
 * @module services/runtimes/claude-code/tool-gate/folder-rule-match
 */

/** The tools one file-edit rule reaches in Claude Code. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'multiedit', 'notebookedit']);

/** The tools one file-read rule reaches in Claude Code. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'ls', 'notebookread']);

/** The tools that run a shell command (`shell-guard/shell-path-guard.ts` lists the same). */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'monitor', 'powershell']);

/**
 * Whether a tool reads or writes files on the computer: the file tools and the shell tools.
 *
 * @param toolName - The tool the call names.
 */
export function reachesFiles(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return EDIT_TOOLS.has(lower) || READ_TOOLS.has(lower) || SHELL_TOOLS.has(lower);
}

/**
 * A shell command with nothing but words in it: letters, digits, spaces and the punctuation a
 * plain argument uses. No quotes, expansions, redirections, separators or new lines.
 */
const PLAIN_COMMAND = /^[\w ./=:,@%+-]+$/;

/** A rule split into the tool it names and the pattern in its parentheses, if any. */
function splitRule(rule: string): { tool: string; pattern: string | undefined } {
  const trimmed = rule.trim();
  const open = trimmed.indexOf('(');
  if (open === -1) return { tool: trimmed, pattern: undefined };
  const pattern = trimmed.endsWith(')') ? trimmed.slice(open + 1, -1) : trimmed.slice(open + 1);
  return { tool: trimmed.slice(0, open).trim(), pattern };
}

/** The family a tool name belongs to, for {@link ruleMayAllow}. */
function familyOf(name: string): ReadonlySet<string> | undefined {
  const lower = name.toLowerCase();
  if (SHELL_TOOLS.has(lower)) return SHELL_TOOLS;
  if (EDIT_TOOLS.has(lower)) return EDIT_TOOLS;
  if (READ_TOOLS.has(lower)) return READ_TOOLS;
  return undefined;
}

/**
 * Whether `rule` might let `toolName` run. Generous on purpose: by tool name only, case ignored,
 * a `*` in the tool name read as "anything from here on", a bare `mcp__{server}` read as every
 * tool that server has, and the tools of one family read as one.
 *
 * @param rule - One `permissions.allow` entry from a folder's settings file.
 * @param toolName - The tool the call names.
 */
export function ruleMayAllow(rule: string, toolName: string): boolean {
  const { tool } = splitRule(rule);
  const want = tool.toLowerCase();
  const call = toolName.toLowerCase();
  if (want.includes('*')) return call.startsWith(want.slice(0, want.indexOf('*')));
  if (want === call) return true;
  if (want.startsWith('mcp__')) return call.startsWith(`${want}__`);
  const family = familyOf(want);
  return family !== undefined && (family.has(call) || SHELL_TOOLS.has(call));
}

/** The host a web fetch names, or `undefined` when its address does not parse. */
function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether `rule` already lets this exact call run, read narrowly (see the module note). A rule
 * this reading does not understand covers nothing.
 *
 * @param rule - A rule a person approved, or one the launch itself passes.
 * @param toolName - The tool the call names.
 * @param input - The call's arguments.
 */
export function ruleCovers(
  rule: string,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  const { tool, pattern } = splitRule(rule);
  if (tool.includes('*')) return false;
  if (pattern === undefined) {
    if (tool === toolName) return true;
    // `mcp__a` covers `mcp__a__b`, but not `mcp__a__b__c`: that may be a tool on server `a__b`.
    const rest = tool.startsWith('mcp__') && toolName.startsWith(`${tool}__`);
    return rest && !toolName.slice(tool.length + 2).includes('__');
  }
  if (tool !== toolName) return false;
  if (tool === 'Bash') {
    const command = input.command;
    if (typeof command !== 'string' || !PLAIN_COMMAND.test(command)) return false;
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2);
      if (!prefix.trim() || !PLAIN_COMMAND.test(prefix)) return false;
      return command === prefix || command.startsWith(`${prefix} `);
    }
    // `npm test *`, the shape an Always allow answer writes: only with something after.
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2);
      if (!prefix.trim() || !PLAIN_COMMAND.test(prefix)) return false;
      return command.startsWith(`${prefix} `) && command.length > prefix.length + 1;
    }
    return !pattern.includes('*') && command === pattern;
  }
  if (tool === 'WebFetch' && pattern.startsWith('domain:')) {
    const host = pattern.slice('domain:'.length).trim().toLowerCase();
    return host.length > 0 && !host.includes('*') && hostOf(input.url) === host;
  }
  return false;
}
