import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import { handleElicitation, type InteractiveSession } from '../messaging/interactive-handlers.js';

function createMockSession(): InteractiveSession {
  return {
    pendingInteractions: new Map(),
    eventQueue: [],
    eventQueueNotify: vi.fn(),
  };
}

describe('handleElicitation', () => {
  let session: InteractiveSession;
  let abortController: AbortController;

  beforeEach(() => {
    session = createMockSession();
    abortController = new AbortController();
  });

  it('pushes an elicitation_prompt event to the event queue', () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Please authenticate',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'elicit-123',
    };

    handleElicitation(session, request, abortController.signal);

    expect(session.eventQueue).toHaveLength(1);
    const event = session.eventQueue[0] as StreamEvent;
    expect(event.type).toBe('elicitation_prompt');
    expect(event.data).toMatchObject({
      serverName: 'test-mcp',
      message: 'Please authenticate',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'elicit-123',
    });
    expect(session.eventQueueNotify).toHaveBeenCalledOnce();
  });

  it('stores a pending interaction keyed by elicitationId', () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Auth',
      elicitationId: 'elicit-abc',
    };

    handleElicitation(session, request, abortController.signal);

    expect(session.pendingInteractions.has('elicit-abc')).toBe(true);
    const pending = session.pendingInteractions.get('elicit-abc')!;
    expect(pending.type).toBe('elicitation');
  });

  it('generates a UUID when elicitationId is absent', () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Auth',
    };

    handleElicitation(session, request, abortController.signal);

    expect(session.pendingInteractions.size).toBe(1);
    const [key] = [...session.pendingInteractions.keys()];
    // UUID v4 format
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('resolves with user accept response', async () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Enter token',
      mode: 'form',
      elicitationId: 'elicit-form',
    };

    const promise = handleElicitation(session, request, abortController.signal);

    // Simulate user submitting
    const pending = session.pendingInteractions.get('elicit-form')!;
    pending.resolve({ action: 'accept', content: { token: '123' } });

    const result = await promise;
    expect(result).toEqual({ action: 'accept', content: { token: '123' } });
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('resolves with decline on reject', async () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Auth',
      elicitationId: 'elicit-rej',
    };

    const promise = handleElicitation(session, request, abortController.signal);

    const pending = session.pendingInteractions.get('elicit-rej')!;
    pending.reject('cancelled');

    const result = await promise;
    expect(result).toEqual({ action: 'decline' });
  });

  it('resolves with decline when signal is aborted', async () => {
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Auth',
      elicitationId: 'elicit-abort',
    };

    const promise = handleElicitation(session, request, abortController.signal);

    abortController.abort();

    const result = await promise;
    expect(result).toEqual({ action: 'decline' });
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('includes form schema in the event data', () => {
    const schema = {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Your username' },
        password: { type: 'string', description: 'Your password' },
      },
    };
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Login required',
      mode: 'form',
      requestedSchema: schema,
    };

    handleElicitation(session, request, abortController.signal);

    const event = session.eventQueue[0] as StreamEvent;
    expect((event.data as Record<string, unknown>).requestedSchema).toEqual(schema);
  });
});
