/**
 * Contextual tool call labels for ToolCallCard headers.
 * Extracts the most relevant detail from each tool's JSON input.
 */
import type { SessionActivity } from '@dorkos/shared/session-stream';

/** Known MCP server display name overrides. */
const MCP_SERVER_LABELS: Record<string, string> = {
  dorkos: 'DorkOS',
  slack: 'Slack',
  telegram: 'Telegram',
  github: 'GitHub',
  filesystem: 'Files',
  playwright: 'Browser',
  context7: 'Context7',
};

/** Convert snake_case to Title Case. */
function humanizeSnakeCase(s: string): string {
  return s
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Parse an MCP tool name into server + tool components. */
export function parseMcpToolName(toolName: string): {
  server: string;
  serverLabel: string;
  tool: string;
  toolLabel: string;
} | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  const server = parts[1];
  const tool = parts.slice(2).join('__');
  const serverLabel = MCP_SERVER_LABELS[server] ?? humanizeSnakeCase(server);
  const toolLabel = humanizeSnakeCase(tool);
  return { server, serverLabel, tool, toolLabel };
}

/** Return the MCP server badge label, or null for non-MCP / DorkOS tools. */
export function getMcpServerBadge(toolName: string): string | null {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return null;
  if (mcp.server === 'dorkos') return null;
  return mcp.serverLabel;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function basename(filePath: string): string {
  if (!filePath) return '...';
  const parts = filePath.split('/');
  return parts[parts.length - 1] || '...';
}

function hostname(url: string): string {
  if (!url) return '...';
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 30);
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '...';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function quote(text: string): string {
  if (!text || text === '...') return '"…"';
  return `"${text}"`;
}

/** Derive a short human-readable label for a tool call from its name and JSON input. */
export function getToolLabel(toolName: string, input: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Input not valid JSON — still try MCP name parsing before falling back
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.toolLabel;
    return toolName;
  }
  if (!parsed || typeof parsed !== 'object') {
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.toolLabel;
    return toolName;
  }

  switch (toolName) {
    case 'Bash':
      return `Run ${quote(truncate(str(parsed.description) || str(parsed.command), 40))}`;
    case 'Read':
      return `Read ${basename(str(parsed.file_path))}`;
    case 'Write':
      return `Write ${basename(str(parsed.file_path))}`;
    case 'Edit':
      return `Edit ${basename(str(parsed.file_path))}`;
    case 'Glob':
      return `Find ${str(parsed.pattern) || '...'}`;
    case 'Grep':
      return `Search ${quote(truncate(str(parsed.pattern), 30))}`;
    case 'Task':
      return `Agent: ${truncate(str(parsed.description) || str(parsed.prompt), 40)}`;
    case 'TaskCreate':
      return `Create task ${quote(truncate(str(parsed.subject), 35))}`;
    case 'TaskUpdate': {
      const id = str(parsed.taskId);
      const status = str(parsed.status);
      return status ? `Update task #${id} → ${status}` : `Update task #${id}`;
    }
    case 'TaskList':
      return 'List tasks';
    case 'Skill':
      return `Skill ${str(parsed.skill) || '...'}`;
    case 'WebSearch':
      return `Search ${quote(truncate(str(parsed.query), 35))}`;
    case 'WebFetch':
      return `Fetch ${hostname(str(parsed.url))}`;
    case 'TaskGet': {
      const id = str(parsed.taskId);
      return `Get task #${id}`;
    }
    case 'TodoWrite': {
      const todos = parsed.todos;
      const count = Array.isArray(todos) ? todos.length : 0;
      return count === 1 ? 'Update tasks (1 item)' : `Update tasks (${count} items)`;
    }
    case 'NotebookEdit':
      return `Edit notebook ${basename(str(parsed.notebook_path))}`;
    case 'EnterPlanMode':
      return 'Enter plan mode';
    case 'ExitPlanMode':
      return 'Exit plan mode';
    case 'ToolSearch':
      return `Search tools ${quote(truncate(str(parsed.query), 30))}`;
    case 'ListMcpResourcesTool': {
      const server = str(parsed.server);
      return server ? `List MCP resources (${server})` : 'List MCP resources';
    }
    case 'ReadMcpResourceTool':
      return `Read MCP resource ${truncate(str(parsed.uri), 30)}`;
    default: {
      const mcp = parseMcpToolName(toolName);
      if (mcp) return mcp.toolLabel;
      return toolName;
    }
  }
}

/**
 * How one tool is phrased, with and without its target — as a CLAUSE.
 *
 * Lowercase and un-punctuated, because two surfaces need two grammars out of one
 * entry: a session's status line says "Reading standup.md…" and a room's lane
 * says "Kai is reading standup.md". Storing the session's framing and stripping
 * it back would be a second, lossier table.
 *
 * Both forms are still written out rather than derived, because the honest
 * generic is rarely the specific clause with the noun removed: "editing a file"
 * is not "editing" and "searching the web" is not "searching the web for".
 */
interface ActivityPhrase {
  /** Phrasing when the reading carries a target. */
  withTarget: (target: string) => string;
  /** Phrasing when it does not — never a guess, only a less specific truth. */
  bare: string;
}

/**
 * Phrasings keyed by LOWERCASED tool name, so one entry covers every runtime's
 * spelling of the same act: claude-code's `Bash`, codex's `Shell`, opencode's
 * `bash`. Anything absent here falls through to the fallback rungs below.
 */
const ACTIVITY_PHRASES: Record<string, ActivityPhrase> = {
  bash: { withTarget: (t) => `running ${t}`, bare: 'running a command' },
  shell: { withTarget: (t) => `running ${t}`, bare: 'running a command' },
  read: { withTarget: (t) => `reading ${t}`, bare: 'reading a file' },
  write: { withTarget: (t) => `writing ${t}`, bare: 'writing a file' },
  edit: { withTarget: (t) => `editing ${t}`, bare: 'editing a file' },
  applypatch: { withTarget: (t) => `editing ${t}`, bare: 'editing a file' },
  notebookedit: { withTarget: (t) => `editing ${t}`, bare: 'editing a notebook' },
  glob: { withTarget: (t) => `looking for ${t}`, bare: 'looking through files' },
  grep: { withTarget: (t) => `searching for ${t}`, bare: 'searching the code' },
  websearch: { withTarget: (t) => `searching the web for ${t}`, bare: 'searching the web' },
  webfetch: { withTarget: (t) => `reading ${t}`, bare: 'reading a web page' },
  task: { withTarget: (t) => `running an agent: ${t}`, bare: 'running an agent' },
  skill: { withTarget: (t) => `using the ${t} skill`, bare: 'using a skill' },
  todowrite: { withTarget: () => 'updating its task list', bare: 'updating its task list' },
};

/**
 * What a session is doing, as a clause that follows "is" — or `null` when
 * nothing is known.
 *
 * The five-rung ladder {@link formatActivityLabel} documented, moved down one
 * level so two framings can share it:
 *
 * 1. A tool this client recognizes, with its target — "editing lane-state.ts"
 * 2. The same tool without one — "editing a file"
 * 3. An MCP tool — the server it is talking to, "using Slack", because the
 *    method name is an implementation detail nobody outside that server reads.
 * 4. A name nothing here has seen (a new runtime, a custom tool) — the name
 *    itself, "using some_future_tool". Verbatim, never guessed at.
 * 5. Nothing known at all — `null`.
 *
 * **The bottom rung is `null` rather than "working"**, and that is the whole
 * reason this is its own function: "working" is the SESSION's honest floor, and
 * a room's floor is its own sentence ("Kai is working on it"). The fallback
 * belongs to each caller, so neither one can put the other's words on screen.
 *
 * @param activity - The session's current activity, or `null`/`undefined` when
 *   the server has not said (an idle session, a turn before its first tool, or a
 *   server that predates the field).
 */
export function activityClause(activity: SessionActivity | null | undefined): string | null {
  if (!activity || activity.toolName.trim() === '') return null;
  const { toolName, target } = activity;

  const phrase = ACTIVITY_PHRASES[toolName.toLowerCase()];
  if (phrase) return target ? phrase.withTarget(target) : phrase.bare;

  const mcp = parseMcpToolName(toolName);
  if (mcp) return `using ${mcp.serverLabel}`;

  return `using ${toolName}`;
}

/**
 * Say what a session is doing right now, in as much detail as is actually
 * known — and no more.
 *
 * {@link activityClause}, framed as the session's status line has always framed
 * it: capitalised, and ended with the ellipsis that says "this line keeps
 * moving". Its bottom rung is "Working…", which is all a `streaming` lifecycle
 * on its own can honestly support.
 *
 * @param activity - The session's current activity, or `null`/`undefined` when
 *   the server has not said (an idle session, a turn before its first tool, or a
 *   server that predates the field).
 */
export function formatActivityLabel(activity: SessionActivity | null | undefined): string {
  const clause = activityClause(activity);
  return clause === null ? 'Working…' : `${clause[0]!.toUpperCase()}${clause.slice(1)}…`;
}
