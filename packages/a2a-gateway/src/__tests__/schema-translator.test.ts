import { describe, it, expect } from 'vitest';
import type { Message } from '@a2a-js/sdk';
import { a2aMessageToRelayPayload } from '../schema-translator.js';

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
