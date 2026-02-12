import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs/promises');

import fs from 'fs/promises';

describe('TranscriptReader', () => {
  let transcriptReader: typeof import('../../services/transcript-reader.js').transcriptReader;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('fs/promises');
    const mod = await import('../../services/transcript-reader.js');
    transcriptReader = mod.transcriptReader;
  });

  describe('readTranscript()', () => {
    it('parses user and assistant messages from JSONL', async () => {
      const lines = [
        JSON.stringify({ type: 'file-history-snapshot' }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'Hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-123');

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        id: 'u1',
        role: 'user',
        content: 'Hello',
      });
      expect(messages[1]).toMatchObject({
        id: 'a1',
        role: 'assistant',
        content: 'Hi there!',
        toolCalls: undefined,
        parts: [{ type: 'text', text: 'Hi there!' }],
      });
    });

    it('extracts tool calls from assistant messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me read that file.' },
              { type: 'tool_use', id: 'tc-1', name: 'Read', input: { file: 'test.ts' } },
            ],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-456');

      expect(messages).toHaveLength(1);
      expect(messages[0].toolCalls).toEqual([
        { toolCallId: 'tc-1', toolName: 'Read', input: '{"file":"test.ts"}', status: 'complete' },
      ]);
      expect(messages[0].parts).toEqual([
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read', input: '{"file":"test.ts"}', status: 'complete' },
      ]);
    });

    it('populates tool results into both toolCalls and parts', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'tc-1', name: 'Read', input: { file: 'test.ts' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-1', content: 'file contents here' },
            ],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-result');

      expect(messages).toHaveLength(1); // tool_result user message is skipped
      expect(messages[0].toolCalls![0].result).toBe('file contents here');
      // The parts-level tool call should also have the result
      const toolPart = messages[0].parts!.find(p => p.type === 'tool_call');
      expect(toolPart).toBeDefined();
      expect((toolPart as any).result).toBe('file contents here');
    });

    it('preserves interleaved order in parts (text -> tool -> text)', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Before the tool.' },
              { type: 'tool_use', id: 'tc-1', name: 'Read', input: { path: '/foo' } },
              { type: 'text', text: 'After the tool.' },
            ],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-interleaved');

      expect(messages).toHaveLength(1);
      expect(messages[0].parts).toHaveLength(3);
      expect(messages[0].parts![0]).toEqual({ type: 'text', text: 'Before the tool.' });
      expect(messages[0].parts![1]).toMatchObject({ type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read' });
      expect(messages[0].parts![2]).toEqual({ type: 'text', text: 'After the tool.' });
      // Content should join all text parts
      expect(messages[0].content).toBe('Before the tool.\nAfter the tool.');
    });

    it('skips system/command user messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: '<local-command-caveat>stuff</local-command-caveat>' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          message: { role: 'user', content: '<command-name>/clear</command-name>' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u3',
          message: { role: 'user', content: 'Real message' },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-789');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Real message');
    });

    it('strips system-reminder tags from user messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: 'Hello <system-reminder>ignore this</system-reminder> world',
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 's1');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello  world');
    });

    it('skips progress and other non-message types', async () => {
      const lines = [
        JSON.stringify({ type: 'progress', uuid: 'p1' }),
        JSON.stringify({ type: 'system', uuid: 's1' }),
        JSON.stringify({ type: 'summary', uuid: 'sm1' }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'Test' },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 's1');

      expect(messages).toHaveLength(1);
    });

    it('returns empty array when file does not exist', async () => {
      (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ENOENT')
      );

      const messages = await transcriptReader.readTranscript('/vault', 'nonexistent');

      expect(messages).toEqual([]);
    });

    it('handles content as array of text blocks in user messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Part 1' },
              { type: 'text', text: 'Part 2' },
            ],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 's1');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Part 1\nPart 2');
    });

    it('skips assistant messages with no text and no tool calls', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'internal thoughts' }],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 's1');

      expect(messages).toHaveLength(0);
    });
  });

  describe('listSessions()', () => {
    /** Helper: create a mock file handle that returns content as a buffer read */
    function mockFileHandle(content: string) {
      return {
        read: vi.fn().mockImplementation((buffer: Buffer, offset: number, length: number) => {
          const bytes = Buffer.from(content, 'utf-8');
          const toCopy = Math.min(bytes.length, length);
          bytes.copy(buffer, offset, 0, toCopy);
          return Promise.resolve({ bytesRead: toCopy, buffer });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('returns session metadata from JSONL files', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        'abc-123.jsonl',
        'def-456.jsonl',
      ]);

      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue(statResult);

      const file1Content = [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          permissionMode: 'default',
          timestamp: '2024-01-01T00:00:00Z',
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'What is the meaning of life?' },
          timestamp: '2024-01-01T00:00:01Z',
        }),
      ].join('\n');

      const file2Content = JSON.stringify({
        type: 'system',
        subtype: 'init',
        permissionMode: 'bypassPermissions',
        timestamp: '2024-01-01T10:00:00Z',
      });

      (fs.open as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockFileHandle(file1Content))
        .mockResolvedValueOnce(mockFileHandle(file2Content));

      const sessions = await transcriptReader.listSessions('/vault');

      expect(sessions).toHaveLength(2);
      const s1 = sessions.find(s => s.id === 'abc-123');
      expect(s1).toBeDefined();
      expect(s1!.title).toBe('What is the meaning of life?');
      expect(s1!.permissionMode).toBe('default');
      expect(s1!.lastMessagePreview).toBeUndefined();

      const s2 = sessions.find(s => s.id === 'def-456');
      expect(s2).toBeDefined();
      expect(s2!.title).toBe('Session def-456');
      expect(s2!.permissionMode).toBe('bypassPermissions');
    });

    it('uses mtime cache on second call', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cached.jsonl']);

      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue(statResult);

      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2024-01-01T00:00:00Z',
      });
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle(content));

      // First call — reads file
      await transcriptReader.listSessions('/vault');
      expect(fs.open).toHaveBeenCalled();

      // Reset call counts, then call again with same mtime
      (fs.open as ReturnType<typeof vi.fn>).mockClear();
      await transcriptReader.listSessions('/vault');
      expect(fs.open).not.toHaveBeenCalled(); // cache hit, no file read
    });

    it('returns empty array when directory does not exist', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ENOENT')
      );

      const sessions = await transcriptReader.listSessions('/vault');

      expect(sessions).toEqual([]);
    });

    it('filters non-JSONL files', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        'abc-123.jsonl',
        'other-file.json',
        'notes.txt',
      ]);

      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue(statResult);

      const content = JSON.stringify({
        type: 'system',
        subtype: 'init',
        timestamp: '2024-01-01T00:00:00Z',
      });
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle(content));

      const sessions = await transcriptReader.listSessions('/vault');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('abc-123');
    });

    it('skips unreadable files', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        'good.jsonl',
        'bad.jsonl',
      ]);

      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };

      // good.jsonl: stat succeeds; bad.jsonl: stat fails
      (fs.stat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(statResult)
        .mockRejectedValueOnce(new Error('EACCES'));

      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Hello' },
      });
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle(content));

      const sessions = await transcriptReader.listSessions('/vault');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('good');
    });

    it('truncates long titles to 80 characters', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['long.jsonl']);

      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue(statResult);

      const longMessage = 'A'.repeat(100);
      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: longMessage },
      });
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle(content));

      const sessions = await transcriptReader.listSessions('/vault');

      expect(sessions[0].title.length).toBeLessThanOrEqual(83); // 80 + '...'
      expect(sessions[0].title.endsWith('...')).toBe(true);
    });
  });

  describe('getSession()', () => {
    function mockFileHandle(content: string) {
      return {
        read: vi.fn().mockImplementation((buffer: Buffer, offset: number, length: number) => {
          const bytes = Buffer.from(content, 'utf-8');
          const toCopy = Math.min(bytes.length, length);
          bytes.copy(buffer, offset, 0, toCopy);
          return Promise.resolve({ bytesRead: toCopy, buffer });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('returns session metadata when file exists', async () => {
      const statResult = {
        birthtime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        mtimeMs: 1704153600000,
      };
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue(statResult);

      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Hello world' },
        timestamp: '2024-01-01T00:00:00Z',
      });
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle(content));

      const session = await transcriptReader.getSession('/vault', 'abc-123');

      expect(session).not.toBeNull();
      expect(session!.id).toBe('abc-123');
      expect(session!.title).toBe('Hello world');
    });

    it('returns null when file does not exist', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ENOENT')
      );

      const session = await transcriptReader.getSession('/vault', 'nonexistent');

      expect(session).toBeNull();
    });
  });

  describe('listTranscripts()', () => {
    it('returns session IDs from JSONL filenames', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
        'abc-123.jsonl',
        'def-456.jsonl',
        'other-file.json',
      ]);

      const ids = await transcriptReader.listTranscripts('/vault');

      expect(ids).toEqual(['abc-123', 'def-456']);
    });

    it('returns empty array when directory does not exist', async () => {
      (fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ENOENT')
      );

      const ids = await transcriptReader.listTranscripts('/vault');

      expect(ids).toEqual([]);
    });
  });

  describe('getProjectSlug()', () => {
    it('converts vault path to slug format', () => {
      const slug = transcriptReader.getProjectSlug('/Users/foo/my-vault');
      expect(slug).toBe('-Users-foo-my-vault');
    });
  });
});
