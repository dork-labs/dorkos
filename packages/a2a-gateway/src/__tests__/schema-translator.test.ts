import { describe, it, expect } from 'vitest';
import type { Message } from '@a2a-js/sdk';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import {
  a2aMessageToRelayPayload,
  relayPayloadToA2aMessage,
  relayStatusToTaskState,
} from '../schema-translator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: 'msg-001',
    parts: [{ kind: 'text', text: 'Hello, agent!' }],
    ...overrides,
  };
}

function makePayload(overrides: Partial<StandardPayload> = {}): StandardPayload {
  return {
    content: 'Agent response here.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// a2aMessageToRelayPayload
// ---------------------------------------------------------------------------

describe('a2aMessageToRelayPayload', () => {
  it('maps a single text part to StandardPayload content', () => {
    const message = makeMessage({
      parts: [{ kind: 'text', text: 'Run the build.' }],
    });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.content).toBe('Run the build.');
  });

  it('concatenates multiple text parts with newlines', () => {
    const message = makeMessage({
      parts: [
        { kind: 'text', text: 'First line.' },
        { kind: 'text', text: 'Second line.' },
        { kind: 'text', text: 'Third line.' },
      ],
    });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.content).toBe('First line.\nSecond line.\nThird line.');
  });

  it('produces empty content string when message has no text parts', () => {
    const message = makeMessage({ parts: [] });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.content).toBe('');
  });

  it('ignores non-text parts (file, data) and only extracts text', () => {
    const message = makeMessage({
      parts: [
        { kind: 'text', text: 'Intro text.' },
        {
          kind: 'file',
          file: { uri: 'https://example.com/report.pdf', mimeType: 'application/pdf' },
        },
        { kind: 'data', data: { key: 'value' } },
        { kind: 'text', text: 'Closing text.' },
      ],
    });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.content).toBe('Intro text.\nClosing text.');
  });

  it('sets senderName to "a2a-client"', () => {
    const payload = a2aMessageToRelayPayload(makeMessage());

    expect(payload.senderName).toBe('a2a-client');
  });

  it('sets channelType to "dm"', () => {
    const payload = a2aMessageToRelayPayload(makeMessage());

    expect(payload.channelType).toBe('dm');
  });

  it('sets performative to "request"', () => {
    const payload = a2aMessageToRelayPayload(makeMessage());

    expect(payload.performative).toBe('request');
  });

  it('maps contextId to conversationId', () => {
    const message = makeMessage({ contextId: 'ctx-abc-123' });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.conversationId).toBe('ctx-abc-123');
  });

  it('maps taskId to correlationId', () => {
    const message = makeMessage({ taskId: 'task-xyz-789' });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.correlationId).toBe('task-xyz-789');
  });

  it('leaves conversationId and correlationId undefined when absent', () => {
    const message = makeMessage({ contextId: undefined, taskId: undefined });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.conversationId).toBeUndefined();
    expect(payload.correlationId).toBeUndefined();
  });

  it('sets responseContext platform to "a2a"', () => {
    const payload = a2aMessageToRelayPayload(makeMessage());

    expect(payload.responseContext?.platform).toBe('a2a');
  });

  it('sets responseContext supportedFormats to ["text/plain"]', () => {
    const payload = a2aMessageToRelayPayload(makeMessage());

    expect(payload.responseContext?.supportedFormats).toEqual(['text/plain']);
  });
});

// ---------------------------------------------------------------------------
// relayPayloadToA2aMessage
// ---------------------------------------------------------------------------

describe('relayPayloadToA2aMessage', () => {
  it('creates an A2A Message with role "agent"', () => {
    const message = relayPayloadToA2aMessage(makePayload(), 'task-1', 'ctx-1');

    expect(message.role).toBe('agent');
  });

  it('sets kind to "message"', () => {
    const message = relayPayloadToA2aMessage(makePayload(), 'task-1', 'ctx-1');

    expect(message.kind).toBe('message');
  });

  it('creates a single TextPart from payload content', () => {
    const payload = makePayload({ content: 'Build completed successfully.' });

    const message = relayPayloadToA2aMessage(payload, 'task-1', 'ctx-1');

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toEqual({ kind: 'text', text: 'Build completed successfully.' });
  });

  it('assigns the provided taskId', () => {
    const message = relayPayloadToA2aMessage(makePayload(), 'task-abc', 'ctx-1');

    expect(message.taskId).toBe('task-abc');
  });

  it('assigns the provided contextId', () => {
    const message = relayPayloadToA2aMessage(makePayload(), 'task-1', 'ctx-xyz');

    expect(message.contextId).toBe('ctx-xyz');
  });

  it('generates a non-empty messageId', () => {
    const message = relayPayloadToA2aMessage(makePayload(), 'task-1', 'ctx-1');

    expect(typeof message.messageId).toBe('string');
    expect(message.messageId.length).toBeGreaterThan(0);
  });

  it('generates unique messageIds on successive calls', () => {
    const payload = makePayload();
    const msg1 = relayPayloadToA2aMessage(payload, 'task-1', 'ctx-1');
    const msg2 = relayPayloadToA2aMessage(payload, 'task-1', 'ctx-1');

    expect(msg1.messageId).not.toBe(msg2.messageId);
  });

  it('handles empty content gracefully', () => {
    const payload = makePayload({ content: '' });

    const message = relayPayloadToA2aMessage(payload, 'task-1', 'ctx-1');

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toEqual({ kind: 'text', text: '' });
  });
});

// ---------------------------------------------------------------------------
// relayStatusToTaskState
// ---------------------------------------------------------------------------

describe('relayStatusToTaskState', () => {
  it('maps "sent" to "working"', () => {
    expect(relayStatusToTaskState('sent')).toBe('working');
  });

  it('maps "delivered" to "completed"', () => {
    expect(relayStatusToTaskState('delivered')).toBe('completed');
  });

  it('maps "failed" to "failed"', () => {
    expect(relayStatusToTaskState('failed')).toBe('failed');
  });

  it('maps "timeout" to "failed"', () => {
    expect(relayStatusToTaskState('timeout')).toBe('failed');
  });

  it('covers all four Relay statuses without exhaustiveness gaps', () => {
    const statuses = ['sent', 'delivered', 'failed', 'timeout'] as const;
    const results = statuses.map(relayStatusToTaskState);

    // Every status must resolve to a defined value
    expect(results.every((r) => typeof r === 'string')).toBe(true);
  });
});
