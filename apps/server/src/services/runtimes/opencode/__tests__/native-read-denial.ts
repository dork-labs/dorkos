/** Test-private matcher for the pinned native PermissionV1.DeniedError message only. */
import { Buffer } from 'node:buffer';

const PREFIX =
  'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ';
const MAX_BYTES = 256 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function matchesNativeReadDenial(
  message: { role: string; tool_call_id?: string; content?: unknown },
  issued: number,
  callId: string
): boolean {
  if (
    issued !== 1 ||
    message.role !== 'tool' ||
    message.tool_call_id !== callId ||
    typeof message.content !== 'string' ||
    Buffer.byteLength(message.content) > MAX_BYTES ||
    !message.content.startsWith(PREFIX)
  )
    return false;
  const suffix = message.content.slice(PREFIX.length);
  let value: unknown;
  try {
    value = JSON.parse(suffix);
  } catch {
    return false;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4096 ||
    JSON.stringify(value) !== suffix
  )
    return false;
  const rows: unknown[] = value;
  if (
    !rows.every(
      (row) =>
        record(row) &&
        Object.keys(row).sort().join(',') === 'action,pattern,permission' &&
        typeof row.permission === 'string' &&
        typeof row.pattern === 'string' &&
        (row.action === 'allow' || row.action === 'ask' || row.action === 'deny')
    )
  )
    return false;
  return rows.some((row) => record(row) && row.permission === 'read' && row.action === 'deny');
}
