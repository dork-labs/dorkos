import { describe, expect, it } from 'vitest';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import {
  connectionRequestIdFromResult,
  connectionRequestIntent,
  findCallRequest,
  isConnectionRequestTool,
} from '../lib/agent-request-call';

function request(overrides: Partial<ConnectorAgentRequestItem>): ConnectorAgentRequestItem {
  return {
    requestId: 'request-1',
    serviceSlug: 'gmail',
    reason: 'Summarise today’s inbox',
    access: 'read',
    requestedEvents: [],
    note: 'The person hasn’t answered yet.',
    createdAt: '2026-09-26T10:00:00.000Z',
    expiresAt: '2026-09-26T12:00:00.000Z',
    status: 'awaiting_owner',
    sessionId: 'session-1',
    agent: { id: 'agent-1', displayName: 'DorkBot' },
    ...overrides,
  } as ConnectorAgentRequestItem;
}

const INPUT = JSON.stringify({
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Summarise today’s inbox',
  access: 'read',
});

describe('isConnectionRequestTool', () => {
  it('recognises the tool as each runtime spells it and nothing else', () => {
    expect(isConnectionRequestTool('mcp__dorkos__connectors.request_connection')).toBe(true);
    expect(isConnectionRequestTool('mcp__dorkos_connections__connectors.request_connection')).toBe(
      true
    );
    expect(isConnectionRequestTool('dorkos_connections_connectors_request_connection')).toBe(true);
    expect(isConnectionRequestTool('mcp__dorkos__connectors.get_connection_request')).toBe(false);
    expect(isConnectionRequestTool('Bash')).toBe(false);
  });
});

describe('reading a call', () => {
  it('reads the intent from well-formed arguments only', () => {
    expect(connectionRequestIntent(INPUT)).toEqual({
      serviceSlug: 'gmail',
      reason: 'Summarise today’s inbox',
    });
    expect(connectionRequestIntent('{"serviceSlug":"gmail"}')).toBeUndefined();
    expect(connectionRequestIntent('not json')).toBeUndefined();
    expect(connectionRequestIntent(undefined)).toBeUndefined();
  });

  it('reads the request id from a plain or an MCP-wrapped result, never from a refusal', () => {
    expect(connectionRequestIdFromResult('{"requestId":"r-1","status":"granted"}')).toBe('r-1');
    expect(
      connectionRequestIdFromResult(
        JSON.stringify({ content: [{ type: 'text', text: '{"requestId":"r-2"}' }] })
      )
    ).toBe('r-2');
    expect(
      connectionRequestIdFromResult('{"error":{"code":"service_unavailable"}}')
    ).toBeUndefined();
  });
});

describe('findCallRequest', () => {
  const older = request({ requestId: 'older', createdAt: '2026-09-26T09:00:00.000Z' });
  const newer = request({ requestId: 'newer', createdAt: '2026-09-26T11:00:00.000Z' });
  const other = request({ requestId: 'other', serviceSlug: 'slack' });

  it('trusts the returned id over the intent', () => {
    expect(
      findCallRequest([older, newer, other], { input: INPUT, result: '{"requestId":"older"}' })
        ?.requestId
    ).toBe('older');
  });

  it('matches a held call by its app, newest first, and ignores other apps', () => {
    expect(
      findCallRequest([older, other, newer], { input: INPUT, result: undefined })?.requestId
    ).toBe('newer');
    expect(findCallRequest([other], { input: INPUT, result: undefined })).toBeUndefined();
  });

  it('matches a reworded or raised ask to the one open request it reused', () => {
    const reworded = JSON.stringify({
      version: 1,
      serviceSlug: 'gmail',
      reason: 'Check for anything from the bank',
      access: 'read-write',
    });
    expect(findCallRequest([newer], { input: reworded, result: undefined })?.requestId).toBe(
      'newer'
    );
  });

  it('finds nothing for a call whose result names no request', () => {
    expect(
      findCallRequest([older], { input: INPUT, result: '{"requestId":"missing"}' })
    ).toBeUndefined();
  });
});
