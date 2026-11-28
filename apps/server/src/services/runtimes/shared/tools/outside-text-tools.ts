/**
 * Which tool calls inside an agent's own runtime hand its turn someone else's text (DOR-3969,
 * spec §4.7): a web page, a search result, an answer from another MCP server. Such a call marks the
 * turn as one that read outside text (`markRunningTurnOutsider`), so a send, a destructive action
 * or a room post later in that turn carries the mark.
 *
 * Two places ask: Claude Code's `PreToolUse` hook, before the tool runs (`outside-text-hook.ts`),
 * and the stream every runtime's turn passes through (`audit/record-tool-use.ts`), as the call
 * starts, for Codex, OpenCode and Doe, which have no hook that runs first.
 *
 * DorkOS's own tools, its connected-app tools included, are never answered here: the server marks
 * those itself when they return outside text (`core/capabilities/dorkos-tool-reads.ts`).
 *
 * Local tools mark by what they are handed (DOR-5236, DOR-5240): a shell command that fetches from
 * the network, runs a script file that does, or names a file in a folder of outside files
 * (`shell-outside-text.ts`), a file read in one of those
 * folders, and a search that reaches one (`outside-file-places.ts`). An input that cannot be read
 * counts as reading outside text. Everything else they do stays unmarked.
 *
 * OpenCode spells another server's tool `server_tool`, with no marker, so there every tool that is
 * not one of its own known local tools marks: an unknown name, or none, fails closed.
 *
 * @module services/runtimes/shared/tools/outside-text-tools
 */
import { DORKOS_CONNECTIONS_SERVER_NAME } from '@dorkos/shared/global-mcp-schemas';
import {
  CLAUDE_CODE_DORKOS_TOOL_PREFIX,
  CODEX_DORKOS_TOOL_PREFIX,
  OPENCODE_DORKOS_TOOL_PREFIX,
} from '../../../core/tool-names/tool-names.js';
import {
  globsKeepIgnores,
  outsideFileTests,
  type CallPlace,
  type SearchWalk,
} from './outside-file-places.js';
import { commandReadsOutsideText, shellCommandOf } from './shell-outside-text.js';

/** Claude Code's tools that bring in outside text: a page, a web search, an MCP server's resource. */
const CLAUDE_CODE_OUTSIDE_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** How Claude Code and Codex spell a tool on DorkOS's connected-app server, which marks its own reads. */
const CONNECTIONS_PREFIX = `mcp__${DORKOS_CONNECTIONS_SERVER_NAME}__`;

/**
 * The `matcher` Claude Code's hook is registered under. It carries `^`, so the CLI reads it as a
 * regular expression rather than a list of exact names (`CLASSIFIER_CONTEXT_MATCHER`'s TSDoc has
 * the rule). It is wider than the answer on purpose: {@link toolReadsOutsideText} leaves DorkOS's
 * own tools out, and a matcher too narrow would fail with no symptom.
 */
export const CLAUDE_CODE_OUTSIDE_TEXT_MATCHER =
  '^(WebFetch|WebSearch|ListMcpResourcesTool|ReadMcpResourceTool|Bash|Read|Grep)$|^mcp__';

/** Codex's tool that searches the web. Codex has no page fetch of its own. */
const CODEX_WEB_SEARCH = 'WebSearch';

/**
 * OpenCode's own tools that only touch this computer, or run nothing by themselves, so their name
 * alone never marks (`bash`, `read` and `grep` still mark by their input). Not `task`: a helper it
 * starts may read anything, so starting one marks.
 */
const OPENCODE_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'multiedit',
  'patch',
  'apply_patch',
  'list',
  'glob',
  'grep',
  'lsp',
  'todowrite',
  'todoread',
  'skill',
  'question',
  'invalid',
]);

/** Doe's page fetch, and the prefix it gives another server's tools (`mcpAlias`). */
const DOE_WEB_FETCH = 'web_fetch';
const DOE_MCP_PREFIX = 'mcp_';
const DOE_CONNECTIONS_PREFIX = `mcp_${DORKOS_CONNECTIONS_SERVER_NAME}_`;

/** Each runtime's shell tool, which marks by the command it runs. Doe has none. */
const SHELL_TOOLS: Readonly<Record<string, string>> = {
  'claude-code': 'Bash',
  codex: 'Shell',
  opencode: 'bash',
};

/** Each runtime's file reads, and the input field naming the file: they mark in a folder of outside files. */
const FILE_READ_TOOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'claude-code': { Read: 'file_path' },
  opencode: { read: 'filePath' },
  doe: { read: 'path' },
};

/**
 * Each runtime's searches, the input field naming where they start (the working folder when it is
 * left out), and how they walk the tree: they mark when that folder holds outside files or has a
 * folder of them below it that the search enters. Claude Code's `Grep` and OpenCode's `grep` run
 * `rg --hidden`, which honours ignore files; Doe's `search` leaves hidden folders out. Codex reads
 * and searches through its shell.
 */
const SEARCH_TOOLS: Readonly<
  Record<string, Readonly<Record<string, { field: string; walk: SearchWalk; globs?: string }>>>
> = {
  'claude-code': {
    Grep: { field: 'path', walk: { skipsHidden: false, ignoreFiles: true }, globs: 'glob' },
  },
  opencode: {
    grep: { field: 'path', walk: { skipsHidden: false, ignoreFiles: true }, globs: 'include' },
  },
  doe: { search: { field: 'path', walk: { skipsHidden: true, ignoreFiles: false } } },
};

/** How a search tool walks for this input: a glob that includes paths reads past ignore files. */
function walkOf(
  search: { walk: SearchWalk; globs?: string },
  fields: Record<string, unknown>
): SearchWalk {
  const given = search.globs === undefined ? undefined : fields[search.globs];
  if (given === undefined || !search.walk.ignoreFiles) return search.walk;
  const globs = typeof given === 'string' ? given.split(/\s+/).filter(Boolean) : null;
  return { ...search.walk, ignoreFiles: globs !== null && globsKeepIgnores(globs) };
}

/** An input that cannot be judged, which counts as reading outside text. */
const UNREADABLE = Symbol('unreadable input');

/** What a tool's input is: an object, the text it came as when that is not JSON, or unreadable. */
function parsedInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    // Text that opens like JSON and does not parse cannot be judged.
    return /^\s*[{[]/.test(input) ? UNREADABLE : input;
  }
}

/** Whether a local tool's input hands the turn outside text: a fetching command, an outside file. */
function inputReadsOutsideText(
  runtime: string,
  toolName: string,
  input: unknown,
  given: CallPlace
): boolean {
  const isShell = SHELL_TOOLS[runtime] === toolName;
  const readField = FILE_READ_TOOLS[runtime]?.[toolName];
  const search = SEARCH_TOOLS[runtime]?.[toolName];
  if (!isShell && readField === undefined && search === undefined) return false;
  const parsed = parsedInput(input);
  if (parsed === UNREADABLE) return true;
  const place = runtime === 'claude-code' ? { ...given, claudeCode: true } : given;
  if (isShell) {
    const shell = shellCommandOf(parsed);
    // A shell call with no command to read cannot be judged.
    if (shell === undefined) return true;
    if (!shell.cwd) return commandReadsOutsideText(shell.command, place);
    // A command run from a folder of outside files reads them by their bare names.
    if (outsideFileTests(place).holds(shell.cwd)) return true;
    return commandReadsOutsideText(shell.command, { ...place, cwd: shell.cwd });
  }
  const fields = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (readField !== undefined) {
    const target = fields[readField];
    return typeof target === 'string' && outsideFileTests(place).holds(target);
  }
  const root = fields[search!.field];
  const start = typeof root === 'string' && root ? root : '.';
  return outsideFileTests(place).searchReaches(start, walkOf(search!, fields));
}

/** Whether an `mcp__server__tool` name is another server's: neither DorkOS's own nor its connected apps'. */
function isOtherServerTool(toolName: string, dorkosPrefix: string): boolean {
  return (
    toolName.startsWith('mcp__') &&
    !toolName.startsWith(dorkosPrefix) &&
    !toolName.startsWith(CONNECTIONS_PREFIX)
  );
}

/**
 * Whether a tool call, as this runtime names it, hands the turn someone else's text.
 *
 * @param runtime - The runtime's type.
 * @param toolName - The tool's name as that runtime reported it.
 * @param input - The call's input, as an object or its JSON text. Without it only the name decides,
 *   so a shell command or a file read is not marked until its input is known.
 * @param place - Where the call runs, so a file in the agent's own folder stays unmarked.
 */
export function toolReadsOutsideText(
  runtime: string,
  toolName: string,
  input?: unknown,
  place: CallPlace = {}
): boolean {
  if (toolReadsByName(runtime, toolName)) return true;
  return input !== undefined && inputReadsOutsideText(runtime, toolName, input, place);
}

/** Whether the tool's name alone says it reads outside text. */
function toolReadsByName(runtime: string, toolName: string): boolean {
  switch (runtime) {
    case 'claude-code':
      return (
        CLAUDE_CODE_OUTSIDE_TOOLS.has(toolName) ||
        isOtherServerTool(toolName, CLAUDE_CODE_DORKOS_TOOL_PREFIX)
      );
    case 'codex':
      return toolName === CODEX_WEB_SEARCH || isOtherServerTool(toolName, CODEX_DORKOS_TOOL_PREFIX);
    case 'opencode':
      return (
        !OPENCODE_LOCAL_TOOLS.has(toolName) && !toolName.startsWith(OPENCODE_DORKOS_TOOL_PREFIX)
      );
    case 'doe':
      return (
        toolName === DOE_WEB_FETCH ||
        (toolName.startsWith(DOE_MCP_PREFIX) && !toolName.startsWith(DOE_CONNECTIONS_PREFIX))
      );
    default:
      return false;
  }
}
