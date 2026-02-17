import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs/promises');
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

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
        {
          type: 'tool_call',
          toolCallId: 'tc-1',
          toolName: 'Read',
          input: '{"file":"test.ts"}',
          status: 'complete',
        },
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
            content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'file contents here' }],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-result');

      expect(messages).toHaveLength(1); // tool_result user message is skipped
      expect(messages[0].toolCalls![0].result).toBe('file contents here');
      // The parts-level tool call should also have the result
      const toolPart = messages[0].parts!.find((p) => p.type === 'tool_call');
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
      expect(messages[0].parts![1]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Read',
      });
      expect(messages[0].parts![2]).toEqual({ type: 'text', text: 'After the tool.' });
      // Content should join all text parts
      expect(messages[0].content).toBe('Before the tool.\nAfter the tool.');
    });

    it('skips local-command messages and converts command+expansion to command type', async () => {
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
          message: { role: 'user', content: 'Expanded prompt for clear' },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);

      const messages = await transcriptReader.readTranscript('/vault', 'session-789');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('/clear');
      expect(messages[0].messageType).toBe('command');
      expect(messages[0].commandName).toBe('/clear');
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
      (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

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

    it('classifies command messages with name and args', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'cmd-meta',
          message: {
            role: 'user',
            content:
              '<command-message>ideate</command-message>\n<command-name>/ideate</command-name>\n<command-args>Add settings screen</command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'cmd-expansion',
          message: {
            role: 'user',
            content: '# Preflight\nYou are a product ideation assistant...',
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-cmd');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'cmd-expansion',
        role: 'user',
        content: '/ideate Add settings screen',
        messageType: 'command',
        commandName: '/ideate',
        commandArgs: 'Add settings screen',
      });
    });

    it('classifies Skill tool invocations as command messages with args', async () => {
      const lines = [
        // Assistant message with Skill tool_use (captures args)
        JSON.stringify({
          type: 'assistant',
          uuid: 'asst-skill',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: "I'll decompose the spec." },
              {
                type: 'tool_use',
                id: 'toolu_abc',
                name: 'Skill',
                input: { skill: 'spec:decompose', args: 'specs/my-feature/02-specification.md' },
              },
            ],
          },
        }),
        // Tool result with toolUseResult.commandName
        JSON.stringify({
          type: 'user',
          uuid: 'skill-result',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_abc',
                content: 'Launching skill: spec:decompose',
              },
            ],
          },
          toolUseResult: { success: true, commandName: 'spec:decompose' },
        }),
        // Expanded skill prompt (plain string)
        JSON.stringify({
          type: 'user',
          uuid: 'skill-expansion',
          message: {
            role: 'user',
            content:
              '# Decompose Specification into Tasks\n\nDecompose the specification at: specs/my-feature/02-specification.md...',
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-skill');

      // Should have the assistant message + the command message (expansion collapsed)
      const cmdMsg = messages.find((m) => m.messageType === 'command');
      expect(cmdMsg).toBeDefined();
      expect(cmdMsg).toMatchObject({
        id: 'skill-expansion',
        role: 'user',
        content: '/spec:decompose specs/my-feature/02-specification.md',
        messageType: 'command',
        commandName: '/spec:decompose',
        commandArgs: 'specs/my-feature/02-specification.md',
      });
    });

    it('handles Skill tool expansion with array content', async () => {
      const lines = [
        // Tool result with toolUseResult.commandName
        JSON.stringify({
          type: 'user',
          uuid: 'skill-result',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'Launching skill: ideate' },
            ],
          },
          toolUseResult: { success: true, commandName: 'ideate' },
        }),
        // Expanded skill prompt as array content (not plain string)
        JSON.stringify({
          type: 'user',
          uuid: 'skill-expansion-array',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '# Preflight\nYou are a product ideation assistant...' },
            ],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-skill-array');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'skill-expansion-array',
        role: 'user',
        content: '/ideate',
        messageType: 'command',
        commandName: '/ideate',
      });
    });

    it('classifies compaction summaries', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'comp-1',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation. Summary here...',
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-comp');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'comp-1',
        role: 'user',
        messageType: 'compaction',
      });
      expect(messages[0].content).toContain('This session is being continued');
    });

    it('skips task notification messages entirely', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'Hello' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'task-1',
          message: {
            role: 'user',
            content:
              '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          message: { role: 'user', content: 'Continue working' },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-task');

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].content).toBe('Continue working');
    });

    it('clears pending command on local-command messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'cmd-meta',
          message: { role: 'user', content: '<command-name>/compact</command-name>' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'local-cmd',
          message: {
            role: 'user',
            content: '<local-command-stdout>Compaction complete</local-command-stdout>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'Next question' },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-local');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Next question');
      expect(messages[0].messageType).toBeUndefined();
    });

    it('normal messages have no messageType', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'What is the weather?' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I cannot check the weather.' }],
          },
        }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
      const messages = await transcriptReader.readTranscript('/vault', 'session-normal');

      expect(messages).toHaveLength(2);
      expect(messages[0].messageType).toBeUndefined();
      expect(messages[1].messageType).toBeUndefined();
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
      const s1 = sessions.find((s) => s.id === 'abc-123');
      expect(s1).toBeDefined();
      expect(s1!.title).toBe('What is the meaning of life?');
      expect(s1!.permissionMode).toBe('default');
      expect(s1!.lastMessagePreview).toBeUndefined();

      const s2 = sessions.find((s) => s.id === 'def-456');
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
      (fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

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
      (fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['good.jsonl', 'bad.jsonl']);

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
      (fs.stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

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
      (fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      const ids = await transcriptReader.listTranscripts('/vault');

      expect(ids).toEqual([]);
    });
  });

  describe('getProjectSlug()', () => {
    it('converts vault path to slug format', () => {
      const slug = transcriptReader.getProjectSlug('/Users/foo/my-vault');
      expect(slug).toBe('-Users-foo-my-vault');
    });

    it('replaces spaces with dashes', () => {
      const slug = transcriptReader.getProjectSlug('/Users/foo/Obsidian Repo');
      expect(slug).toBe('-Users-foo-Obsidian-Repo');
    });

    it('replaces dots with dashes', () => {
      const slug = transcriptReader.getProjectSlug('/Users/foo/.Trash/project');
      expect(slug).toBe('-Users-foo--Trash-project');
    });

    it('replaces all non-alphanumeric non-dash characters', () => {
      const slug = transcriptReader.getProjectSlug('/Users/foo/my project (v2)');
      expect(slug).toBe('-Users-foo-my-project--v2-');
    });
  });

  describe('getTranscriptETag', () => {
    it('returns ETag string based on mtime and size', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
        mtimeMs: 1700000000000,
        size: 4096,
      });

      const etag = await transcriptReader.getTranscriptETag('/vault', 'session-123');
      expect(etag).toBe('"1700000000000-4096"');
    });

    it('returns null when file does not exist', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      const etag = await transcriptReader.getTranscriptETag('/vault', 'nonexistent');
      expect(etag).toBeNull();
    });

    it('returns different ETag after file is modified', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
        mtimeMs: 1700000000000,
        size: 4096,
      });
      const etag1 = await transcriptReader.getTranscriptETag('/vault', 'session-123');

      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
        mtimeMs: 1700000001000,
        size: 8192,
      });
      const etag2 = await transcriptReader.getTranscriptETag('/vault', 'session-123');

      expect(etag1).not.toBe(etag2);
    });
  });

  describe('readFromOffset', () => {
    it('returns empty content when file has not grown', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 100 });

      const result = await transcriptReader.readFromOffset('/vault', 'session-123', 100);
      expect(result).toEqual({ content: '', newOffset: 100 });
    });

    it('returns new content from offset to end of file', async () => {
      const newContent = '{"type":"user","message":{"content":"hello"}}\n';
      const buffer = Buffer.from(newContent);

      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 200 + buffer.length });

      const mockFileHandle = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          buffer.copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle);

      const result = await transcriptReader.readFromOffset('/vault', 'session-123', 200);
      expect(result.newOffset).toBe(200 + buffer.length);
      expect(result.content).toBe(newContent);
    });

    it('updates newOffset to current file size', async () => {
      const newContent = 'new data';
      const buffer = Buffer.from(newContent);

      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 500 });

      const mockFileHandle = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          Buffer.from(newContent).copy(buf);
          return Promise.resolve({ bytesRead: buffer.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle);

      const result = await transcriptReader.readFromOffset('/vault', 'session-123', 492);
      expect(result.newOffset).toBe(500);
    });

    it('reads only appended bytes, not full file', async () => {
      const newContent = 'appended';
      const fromOffset = 1000;
      const fileSize = 1000 + newContent.length;

      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: fileSize });

      const mockFileHandle = {
        read: vi.fn().mockImplementation((buf: Buffer) => {
          Buffer.from(newContent).copy(buf);
          return Promise.resolve({ bytesRead: newContent.length });
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle);

      await transcriptReader.readFromOffset('/vault', 'session-123', fromOffset);

      // Verify read was called with correct offset parameter (position 1000)
      expect(mockFileHandle.read).toHaveBeenCalledWith(
        expect.any(Buffer),
        0,
        newContent.length,
        fromOffset
      );
    });

    it('properly closes file handle in all cases', async () => {
      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 200 });

      const mockFileHandle = {
        read: vi.fn().mockRejectedValue(new Error('read error')),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (fs.open as ReturnType<typeof vi.fn>).mockResolvedValue(mockFileHandle);

      await expect(transcriptReader.readFromOffset('/vault', 'session-123', 100)).rejects.toThrow(
        'read error'
      );

      expect(mockFileHandle.close).toHaveBeenCalled();
    });
  });
});
