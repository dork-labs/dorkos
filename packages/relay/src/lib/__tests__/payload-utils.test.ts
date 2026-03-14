import { describe, it, expect } from 'vitest';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  formatForPlatform,
  SILENT_EVENT_TYPES,
} from '../payload-utils.js';

describe('extractPayloadContent', () => {
  it('returns string payload directly', () => {
    expect(extractPayloadContent('hello')).toBe('hello');
  });

  it('extracts content field from object', () => {
    expect(extractPayloadContent({ content: 'hello', other: 123 })).toBe('hello');
  });

  it('extracts text field from object when content is missing', () => {
    expect(extractPayloadContent({ text: 'hello', other: 123 })).toBe('hello');
  });

  it('prefers content over text', () => {
    expect(extractPayloadContent({ content: 'a', text: 'b' })).toBe('a');
  });

  it('falls back to JSON.stringify for other objects', () => {
    expect(extractPayloadContent({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('handles null payload', () => {
    expect(extractPayloadContent(null)).toBe('null');
  });

  it('handles undefined payload', () => {
    expect(extractPayloadContent(undefined)).toBe(undefined);
  });

  it('handles unserializable payload (circular reference)', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(extractPayloadContent(obj)).toBe('[unserializable payload]');
  });

  it('handles number payload', () => {
    expect(extractPayloadContent(42)).toBe('42');
  });

  it('handles empty string payload', () => {
    expect(extractPayloadContent('')).toBe('');
  });

  it('handles object with non-string content field', () => {
    expect(extractPayloadContent({ content: 42 })).toBe('{"content":42}');
  });

  it('handles object with non-string text field', () => {
    expect(extractPayloadContent({ text: true })).toBe('{"text":true}');
  });

  it('handles array payload', () => {
    expect(extractPayloadContent([1, 2, 3])).toBe('[1,2,3]');
  });

  it('handles deeply nested object without top-level content', () => {
    const payload = { nested: { deep: { content: 'found' } } };
    // Should NOT find nested content — only checks top-level
    expect(extractPayloadContent(payload)).toBe(JSON.stringify(payload));
  });

  it('handles boolean payload', () => {
    expect(extractPayloadContent(true)).toBe('true');
  });
});

describe('detectStreamEventType', () => {
  it('returns type for valid StreamEvent with type and data', () => {
    expect(detectStreamEventType({ type: 'text_delta', data: { text: 'hi' } })).toBe('text_delta');
  });

  it('returns type for session_status event', () => {
    expect(detectStreamEventType({ type: 'session_status', data: { sessionId: 'abc' } })).toBe('session_status');
  });

  it('returns type for done event', () => {
    expect(detectStreamEventType({ type: 'done', data: {} })).toBe('done');
  });

  it('returns null for object without data field', () => {
    expect(detectStreamEventType({ type: 'text_delta' })).toBeNull();
  });

  it('returns null for object without type field', () => {
    expect(detectStreamEventType({ data: { text: 'hi' } })).toBeNull();
  });

  it('returns null for non-string type', () => {
    expect(detectStreamEventType({ type: 42, data: {} })).toBeNull();
  });

  it('returns null for null', () => {
    expect(detectStreamEventType(null)).toBeNull();
  });

  it('returns null for string', () => {
    expect(detectStreamEventType('not an event')).toBeNull();
  });

  it('returns null for number', () => {
    expect(detectStreamEventType(42)).toBeNull();
  });

  it('returns type even when data is null', () => {
    expect(detectStreamEventType({ type: 'error', data: null })).toBe('error');
  });
});

describe('extractTextDelta', () => {
  it('returns text for valid text_delta event', () => {
    expect(extractTextDelta({ type: 'text_delta', data: { text: 'Hello ' } })).toBe('Hello ');
  });

  it('returns null for non-text_delta event type', () => {
    expect(extractTextDelta({ type: 'session_status', data: { text: 'hi' } })).toBeNull();
  });

  it('returns null when data.text is not a string', () => {
    expect(extractTextDelta({ type: 'text_delta', data: { text: 42 } })).toBeNull();
  });

  it('returns null when data is missing', () => {
    expect(extractTextDelta({ type: 'text_delta' })).toBeNull();
  });

  it('returns null for null payload', () => {
    expect(extractTextDelta(null)).toBeNull();
  });

  it('returns null for string payload', () => {
    expect(extractTextDelta('text_delta')).toBeNull();
  });

  it('returns empty string for empty text_delta', () => {
    expect(extractTextDelta({ type: 'text_delta', data: { text: '' } })).toBe('');
  });
});

describe('extractErrorMessage', () => {
  it('returns message for valid error event', () => {
    expect(extractErrorMessage({ type: 'error', data: { message: 'Something broke' } })).toBe('Something broke');
  });

  it('returns null for non-error event type', () => {
    expect(extractErrorMessage({ type: 'text_delta', data: { message: 'hi' } })).toBeNull();
  });

  it('returns null when data.message is not a string', () => {
    expect(extractErrorMessage({ type: 'error', data: { message: 42 } })).toBeNull();
  });

  it('returns null when data is missing', () => {
    expect(extractErrorMessage({ type: 'error' })).toBeNull();
  });

  it('returns null for null payload', () => {
    expect(extractErrorMessage(null)).toBeNull();
  });

  it('returns null for string payload', () => {
    expect(extractErrorMessage('error')).toBeNull();
  });
});

describe('SILENT_EVENT_TYPES', () => {
  it('contains expected event types', () => {
    expect(SILENT_EVENT_TYPES.has('session_status')).toBe(true);
    expect(SILENT_EVENT_TYPES.has('tool_call_start')).toBe(true);
    expect(SILENT_EVENT_TYPES.has('tool_call_delta')).toBe(true);
    expect(SILENT_EVENT_TYPES.has('tool_call_end')).toBe(true);
    expect(SILENT_EVENT_TYPES.has('tool_result')).toBe(true);
    expect(SILENT_EVENT_TYPES.has('task_update')).toBe(true);
  });

  it('does not contain content event types', () => {
    expect(SILENT_EVENT_TYPES.has('text_delta')).toBe(false);
    expect(SILENT_EVENT_TYPES.has('done')).toBe(false);
    expect(SILENT_EVENT_TYPES.has('error')).toBe(false);
  });
});

describe('formatForPlatform', () => {
  describe('slack', () => {
    it('converts **bold** to *bold*', () => {
      const result = formatForPlatform('**bold**', 'slack');
      // slackify-markdown may add zero-width spaces around formatting markers
      expect(result).toContain('*bold*');
      expect(result).not.toContain('**');
    });

    it('converts [link](url) to <url|link>', () => {
      const result = formatForPlatform('[Click here](https://example.com)', 'slack');
      expect(result).toContain('<https://example.com|Click here>');
    });

    it('handles multi-line markdown', () => {
      const input = '# Heading\n\n**Bold** and *italic*';
      const result = formatForPlatform(input, 'slack');
      expect(result).not.toContain('**');
      expect(result).toContain('*Bold*');
    });

    it('returns empty string for empty input', () => {
      expect(formatForPlatform('', 'slack')).toBe('');
    });
  });

  describe('telegram', () => {
    it('passes through unchanged', () => {
      expect(formatForPlatform('**bold**', 'telegram')).toBe('**bold**');
    });
  });

  describe('plain', () => {
    it('strips bold markers', () => {
      expect(formatForPlatform('**bold**', 'plain')).toBe('bold');
    });

    it('strips italic markers', () => {
      expect(formatForPlatform('*italic*', 'plain')).toBe('italic');
    });

    it('strips inline code backticks', () => {
      expect(formatForPlatform('use `foo()`', 'plain')).toBe('use foo()');
    });

    it('strips link markdown, keeps text', () => {
      expect(formatForPlatform('[link](https://example.com)', 'plain')).toBe('link');
    });

    it('strips heading markers', () => {
      expect(formatForPlatform('## Heading', 'plain')).toBe('Heading');
    });
  });
});
