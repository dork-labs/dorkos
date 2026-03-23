/**
 * Contextual tool call labels for ToolCallCard headers.
 * Extracts the most relevant detail from each tool's JSON input.
 */

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
    return toolName;
  }
  if (!parsed || typeof parsed !== 'object') return toolName;

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
