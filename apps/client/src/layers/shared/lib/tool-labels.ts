/**
 * Contextual tool call labels for ToolCallCard headers.
 * Extracts the most relevant detail from each tool's JSON input.
 */

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
    default:
      return toolName;
  }
}
