import { describe, it, expect } from 'vitest';
import { Role, type Message, type Part } from '@a2a-js/sdk';
import { a2aMessageToRelayPayload } from '../schema-translator.js';
import { buildMessage, textPart } from '../a2a-model.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    ...buildMessage({ role: Role.ROLE_USER, text: 'Hello, agent!', messageId: 'msg-001' }),
    ...overrides,
  };
}

/** A file part carrying a url — one of the shapes that has no text to extract. */
function filePart(uri: string, mediaType: string): Part {
  return {
    content: { $case: 'url', value: uri },
    metadata: undefined,
    filename: '',
    mediaType,
  };
}

/** A structured-data part — the other shape with no text to extract. */
function dataPart(data: unknown): Part {
  return {
    content: { $case: 'data', value: data },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  };
}

// ---------------------------------------------------------------------------
// a2aMessageToRelayPayload
// ---------------------------------------------------------------------------

describe('a2aMessageToRelayPayload', () => {
  it('maps a single text part to StandardPayload content', () => {
    const message = makeMessage({
      parts: [textPart('Run the build.')],
    });

    const payload = a2aMessageToRelayPayload(message);

    expect(payload.content).toBe('Run the build.');
  });

  it('concatenates multiple text parts with newlines', () => {
    const message = makeMessage({
      parts: [textPart('First line.'), textPart('Second line.'), textPart('Third line.')],
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
        textPart('Intro text.'),
        filePart('https://example.com/report.pdf', 'application/pdf'),
        dataPart({ key: 'value' }),
        textPart('Closing text.'),
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
    // A2A v1.0 is protobuf-shaped and has no null: an unset id arrives as the
    // empty string, which must NOT become an empty-string correlationId on the
    // Relay side — absent and empty are different things there.
    const message = makeMessage({ contextId: '', taskId: '' });

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
