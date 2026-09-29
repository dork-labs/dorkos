/**
 * Pure reading of an agent's `request_connection` tool call, so a transcript
 * can draw the owner's card where the agent asked.
 *
 * The call itself is the anchor: it is already a durable part of the
 * transcript on every runtime, at exactly the point the agent asked, and it
 * survives a reload. Which request it opened is read from its result once the
 * call returns, and from the app it asked for while the call is still held
 * open waiting for the owner, because a held call has no result yet. The
 * server keeps one open request per agent and app, whatever the reason says
 * (DOR-2497), so the app names one request.
 *
 * @module features/connections/lib/agent-request-call
 */
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';

/**
 * Whether a tool name is the connection-request tool as some runtime spells it:
 * `mcp__dorkos__connectors.request_connection` (Claude Code),
 * `mcp__dorkos_connections__connectors.request_connection` (Codex), or
 * `dorkos_connections_connectors_request_connection` (OpenCode).
 *
 * @param toolName - The tool call's name as the transcript recorded it.
 */
export function isConnectionRequestTool(toolName: string): boolean {
  return (
    toolName.endsWith('connectors.request_connection') ||
    toolName.endsWith('connectors_request_connection')
  );
}

/** What an agent asked for, read from the call's arguments. */
export interface ConnectionRequestIntent {
  /** The service slug. */
  readonly serviceSlug: string;
  /** The agent's own reason. */
  readonly reason: string;
}

/** Parse JSON without throwing; anything unreadable is `undefined`. */
function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The intent in a call's arguments, or `undefined` when they are not a
 * well-formed request (a malformed call opened no request).
 *
 * @param input - The call's arguments as recorded (JSON text).
 */
export function connectionRequestIntent(
  input: string | undefined
): ConnectionRequestIntent | undefined {
  const parsed = parseJson(input);
  if (!isRecord(parsed)) return undefined;
  const { serviceSlug, reason } = parsed;
  if (typeof serviceSlug !== 'string' || typeof reason !== 'string') return undefined;
  return { serviceSlug, reason };
}

/**
 * The request id a returned call names, or `undefined` when it has not
 * returned or returned a refusal (no request was opened).
 *
 * A runtime may record the result as the tool's JSON text or as the MCP
 * envelope around it (`{ content: [{ type: 'text', text }] }`); both are read.
 *
 * @param result - The call's result as recorded.
 */
export function connectionRequestIdFromResult(result: string | undefined): string | undefined {
  const parsed = parseJson(result);
  if (isRecord(parsed) && typeof parsed.requestId === 'string') return parsed.requestId;
  if (isRecord(parsed) && Array.isArray(parsed.content)) {
    const text = parsed.content
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .join('');
    return connectionRequestIdFromResult(text);
  }
  return undefined;
}

/**
 * The request a call opened, among one conversation's requests: the exact id
 * when the call returned, otherwise the newest request for the call's app. A
 * reworded or raised ask reuses the open request, so the reason and level are
 * not compared.
 *
 * @param requests - The conversation's requests, as the owner reads them.
 * @param call - The call's arguments and result.
 * @param call.input - Arguments as recorded.
 * @param call.result - Result as recorded, when the call returned.
 */
export function findCallRequest(
  requests: readonly ConnectorAgentRequestItem[],
  call: { input: string | undefined; result: string | undefined }
): ConnectorAgentRequestItem | undefined {
  const requestId = connectionRequestIdFromResult(call.result);
  if (requestId) return requests.find((request) => request.requestId === requestId);
  const intent = connectionRequestIntent(call.input);
  if (!intent) return undefined;
  return requests
    .filter((request) => request.serviceSlug === intent.serviceSlug)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}
