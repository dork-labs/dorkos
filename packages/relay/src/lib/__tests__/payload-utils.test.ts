import { describe, it, expect } from 'vitest';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  formatForPlatform,
  extractApprovalData,
  formatToolDescription,
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

describe('extractApprovalData', () => {
  it('returns approval data from valid approval_required payload', () => {
    const payload = {
      type: 'approval_required',
      data: {
        toolCallId: 'toolu_123',
        toolName: 'Write',
        input: '{"path":"src/index.ts","content":"hello"}',
        timeoutMs: 600000,
      },
    };
    const result = extractApprovalData(payload);
    expect(result).toEqual({
      toolCallId: 'toolu_123',
      toolName: 'Write',
      input: '{"path":"src/index.ts","content":"hello"}',
      timeoutMs: 600000,
    });
  });

  it('returns null for non-approval_required payload', () => {
    expect(extractApprovalData({ type: 'text_delta', data: { text: 'hi' } })).toBeNull();
  });

  it('returns null for missing toolCallId', () => {
    expect(extractApprovalData({ type: 'approval_required', data: { toolName: 'Write' } })).toBeNull();
  });

  it('returns null for missing toolName', () => {
    expect(extractApprovalData({ type: 'approval_required', data: { toolCallId: 'x' } })).toBeNull();
  });

  it('returns null for null payload', () => {
    expect(extractApprovalData(null)).toBeNull();
  });

  it('returns null for string payload', () => {
    expect(extractApprovalData('hello')).toBeNull();
  });

  it('defaults input to empty string when missing', () => {
    const result = extractApprovalData({
      type: 'approval_required',
      data: { toolCallId: 'x', toolName: 'Write' },
    });
    expect(result?.input).toBe('');
  });

  it('defaults timeoutMs to 600000 when missing', () => {
    const result = extractApprovalData({
      type: 'approval_required',
      data: { toolCallId: 'x', toolName: 'Write' },
    });
    expect(result?.timeoutMs).toBe(600_000);
  });
});

describe('formatToolDescription', () => {
  it('describes Write tool with file path', () => {
    expect(formatToolDescription('Write', '{"path":"src/index.ts","content":"x"}')).toBe(
      'wants to write to `src/index.ts`',
    );
  });

  it('describes Edit tool with file_path', () => {
    expect(formatToolDescription('Edit', '{"file_path":"src/app.ts"}')).toBe(
      'wants to edit `src/app.ts`',
    );
  });

  it('describes Bash tool with short command', () => {
    expect(formatToolDescription('Bash', '{"command":"ls -la"}')).toBe(
      'wants to run `ls -la`',
    );
  });

  it('truncates long Bash commands', () => {
    const longCmd = 'a'.repeat(100);
    const result = formatToolDescription('Bash', JSON.stringify({ command: longCmd }));
    expect(result.length).toBeLessThan(80);
    expect(result).toContain('...');
  });

  it('falls back to generic description for unknown tools', () => {
    expect(formatToolDescription('CustomTool', '{}')).toBe('wants to use tool `CustomTool`');
  });

  it('falls back to generic description for non-JSON input', () => {
    expect(formatToolDescription('Write', 'not json')).toBe('wants to use tool `Write`');
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
