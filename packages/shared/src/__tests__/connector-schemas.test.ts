import { describe, expect, it } from 'vitest';
import {
  ConnectorReviewActionSchema,
  decodeConnectorReviewAction,
  encodeConnectorReviewAction,
} from '../connector-schemas.js';

describe('ConnectorReviewActionSchema', () => {
  it('round-trips one canonical discriminated action', () => {
    const action = ConnectorReviewActionSchema.parse({
      version: 1,
      kind: 'set_agent_access',
      connectionId: 'connection-1',
      agentId: 'agent-a',
      operationRevisionIds: ['revision-read', 'revision-write'],
    });

    expect(decodeConnectorReviewAction(encodeConnectorReviewAction(action))).toEqual(action);
  });

  it('validates an agent connection request without any private account selector', () => {
    const action = ConnectorReviewActionSchema.parse({
      version: 1,
      kind: 'agent_connection_request',
      serviceSlug: 'gmail',
      reason: 'Read messages for the current task.',
      requestedOperations: ['gmail.messages.list'],
    });

    expect(action).toEqual({
      version: 1,
      kind: 'agent_connection_request',
      serviceSlug: 'gmail',
      reason: 'Read messages for the current task.',
      requestedOperations: ['gmail.messages.list'],
      requestedEvents: [],
    });
    expect(
      ConnectorReviewActionSchema.safeParse({ ...action, connectionId: 'private-choice' }).success
    ).toBe(false);
  });

  it.each([
    {
      version: 1,
      kind: 'grant_everything',
      connectionId: 'connection-1',
    },
    {
      version: 2,
      kind: 'pause',
      connectionId: 'connection-1',
    },
    {
      version: 1,
      kind: 'pause',
      connectionId: 'connection-1',
      operationRevisionIds: ['wildcard'],
    },
  ])('rejects unknown kinds, versions, and fields: $kind v$version', (candidate) => {
    expect(ConnectorReviewActionSchema.safeParse(candidate).success).toBe(false);
  });
});
