import type { RequestFacts } from '../../../http/request-facts.js';
import { classifyRequest } from '../../../lib/request-classifier.js';
import { currentServerRole } from '../../../lib/server-role.js';
import { credentialRef } from '../../audit/account-ids.js';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { OWNER_READER } from '../../audit/visibility.js';
import { describeUserAgent } from '../../../lib/http/user-agent.js';

const REMOTE_SESSION_ACTION = 'mcp.remote_session';
const REMOTE_KEY_CREATED_ACTION = 'api_key.created_remotely';

/**
 * Record where a confirmed remote key was made, without recording its settings.
 * @param request - The confirming browser's route and caller facts.
 * @param response - The key creation response, returned without consuming it.
 */
export async function recordApiKeyCreationRoute(
  request: RequestFacts,
  response: Response
): Promise<Response> {
  const route = classifyRequest(request, currentServerRole()).route;
  if (!response.ok || (route !== 'own-tunnel' && route !== 'managed')) return response;
  const key: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(key) || typeof key.id !== 'string') return response;
  const credential = credentialRef('api-key', key.id);
  recordAudit({
    action: REMOTE_KEY_CREATED_ACTION,
    operation: 'create',
    outcome: 'ok',
    target: { type: 'api-key-reference', id: credential.idHash },
    credential,
    source: { surface: 'app', userAgent: request.headers['user-agent'] },
    summary: 'Created an API key over Remote Access',
    visibility: 'admins',
  });
  return response;
}

/**
 * Record an admitted remote MCP session. The transport is stateless, so each
 * POST creates a fresh session and gets one access row, including discovery.
 * Called only inside the endpoint, after its credential and traffic gates.
 * Never records the bearer, body, URL query, or tool arguments.
 */
export function recordRemoteMcpSession(request: RequestFacts): void {
  if (classifyRequest(request, currentServerRole()).route === 'local') return;
  const keyId = request.user?.credential === 'api-key' ? request.user.credentialId : undefined;
  const credential = keyId ? credentialRef('api-key', keyId) : undefined;
  const userAgent = request.headers['user-agent'];
  recordAudit({
    source: {
      surface: 'mcp',
      ...(request.peerAddress ? { ip: request.peerAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    },
    ...(credential
      ? {
          credential,
          target: { type: 'api-key-reference', id: credential.idHash },
        }
      : {}),
    action: REMOTE_SESSION_ACTION,
    operation: 'access',
    outcome: 'ok',
    summary: 'Started a remote tool session',
    visibility: 'admins',
  });
}

/** Whether a decoded JSON value is a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add `lastUsedRemotelyAt` to Better Auth's already-authorized key list. Only
 * IDs returned by that handler are looked up; its auth, pagination and other
 * fields stay authoritative. Derive timestamps from the persistent audit rows
 * rather than conflating local key checks with remote use. No schema migration
 * or key metadata overwrite is needed.
 */
export async function annotateRemoteMcpKeyList(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.apiKeys)) return response;
  const trail = auditTrail();
  const apiKeys = body.apiKeys.map((key: unknown) => {
    if (!isRecord(key) || typeof key.id !== 'string') return key;
    const last = trail?.log.query(
      {
        targetId: credentialRef('api-key', key.id).idHash,
        action: REMOTE_SESSION_ACTION,
        limit: 1,
      },
      OWNER_READER
    ).events[0];
    const made = trail?.log.query(
      {
        targetId: credentialRef('api-key', key.id).idHash,
        action: REMOTE_KEY_CREATED_ACTION,
        limit: 1,
      },
      OWNER_READER
    ).events[0];
    return {
      ...key,
      lastUsedRemotelyAt: last?.at ?? null,
      createdFrom: made ? `${describeUserAgent(made.source?.userAgent)} over Remote Access` : null,
    };
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...body, apiKeys }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
