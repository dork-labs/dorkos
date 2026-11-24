/**
 * session-mapper: history. Shared setup lives in `./session-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeSessionMapper } from '../../sessions/session-mapper.js';
import {
  PROJECT_DIR,
  DORKOS_ID,
  CREATED_MS,
  ocSession,
  userMessage,
  assistantMessage,
  textPart,
  toolPart,
  createMockClient,
  serveSessions,
  createProvider,
} from './session-mapper.fixtures.js';

// SDK-only access guard (ADR-0308: OpenCode's store is opaque, runtime-owned).
// The mapper must reach session data exclusively through the SDK client — if it
// (or anything in its runtime import graph) ever imports the filesystem, these
// throwing factories fail the suite at module load.
//
// A `vi.mock` reaches the WHOLE module graph, not just the mapper's, so the
// vectors above come from their own subpath rather than the `@dorkos/test-utils`
// barrel. The barrel re-exports the runtime conformance suite, which legitimately
// resolves real paths, and pulling it in here would fail this file for something
// that is not the mapper and not in the mapper's graph at all.
vi.mock('node:fs', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

vi.mock('node:fs/promises', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

describe('OpenCodeSessionMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMessageHistory', () => {
    it('reads via the SDK and maps text, reasoning, and tool parts', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: userMessage(),
            parts: [textPart('Run the tests')],
          },
          {
            info: assistantMessage(),
            parts: [
              {
                id: 'prt_r1',
                sessionID: 'ses_hist',
                messageID: 'msg_asst1',
                type: 'reasoning',
                text: 'Let me think.',
                time: { start: CREATED_MS },
              },
              textPart('Running now.'),
              textPart('One moment.'),
              toolPart({
                status: 'completed',
                input: { command: 'pnpm test' },
                output: 'all green',
                title: 'pnpm test',
                metadata: {},
                time: { start: CREATED_MS, end: CREATED_MS + 100 },
              }),
              {
                id: 'prt_step',
                sessionID: 'ses_hist',
                messageID: 'msg_asst1',
                type: 'step-start',
              },
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_hist' } });
      expect(history).toHaveLength(2);

      expect(history[0]).toMatchObject({
        id: 'msg_user1',
        role: 'user',
        content: 'Run the tests',
      });

      const assistant = history[1]!;
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toBe('Running now.\nOne moment.');
      expect(assistant.timestamp).toBe(new Date(CREATED_MS + 1_000).toISOString());
      // Consecutive text parts merge; step-start has no projection.
      expect(assistant.parts?.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
      expect(assistant.parts?.[2]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'bash',
        input: JSON.stringify({ command: 'pnpm test' }),
        result: 'all green',
        status: 'complete',
      });
      expect(assistant.toolCalls).toEqual([
        {
          toolCallId: 'call_1',
          toolName: 'bash',
          input: JSON.stringify({ command: 'pnpm test' }),
          result: 'all green',
          status: 'complete',
        },
      ]);
    });

    // A failed turn is recorded in OpenCode's store as an assistant message
    // carrying `error` — often with NO parts at all. Measured on this machine's
    // opencode.db: all six `APIError` rows have zero parts, and the message
    // below is one of them, copied verbatim. The parts-only reader dropped
    // them, so a reopened transcript showed the question and nothing after it
    // (DOR-1666).
    it('keeps a turn that failed with nothing said, as a typed error part', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          { info: userMessage(), parts: [textPart('Run the tests')] },
          {
            info: assistantMessage({
              id: 'msg_failed',
              error: {
                name: 'APIError',
                data: {
                  message:
                    'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2809. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
                  statusCode: 402,
                  isRetryable: false,
                },
              },
            }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(history).toHaveLength(2);
      const failed = history[1]!;
      expect(failed).toMatchObject({ id: 'msg_failed', role: 'assistant' });
      // The provider's own words, link intact — that URL is the remedy.
      expect(failed.parts).toEqual([
        {
          type: 'error',
          message:
            'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2809. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
          category: 'execution_error',
          details: '[APIError]',
        },
      ]);
    });

    // The blast radius of a throw here is the whole chat, not one
    // message: `getMessageHistory` throwing is caught by the runtime facade and
    // turned into the log-backed EventLog fallback, which for a session adopted
    // from the OpenCode TUI holds nothing at all. Before the payload was
    // Zod-parsed, `{name:'APIError'}` with no `data` threw a TypeError here and
    // blanked every message in the session. The sidecar is an unpinned external
    // binary whose generated types this adapter has already caught being wrong
    // (DOR-1147), so this is a shape that can really arrive.
    it('an off-type error costs its own part, never the rest of the transcript', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          { info: userMessage({ id: 'msg_ask' }), parts: [textPart('Run the tests')] },
          {
            info: assistantMessage({ id: 'msg_said' }),
            parts: [textPart('Here is the answer.')],
          },
          // Three shapes the declared type says are impossible.
          {
            // @ts-expect-error - `data` is required by the SDK type; the sidecar is not.
            info: assistantMessage({ id: 'msg_nodata', error: { name: 'APIError' } }),
            parts: [],
          },
          {
            // @ts-expect-error - `error` is never null in the declared type.
            info: assistantMessage({ id: 'msg_null', error: null }),
            parts: [textPart('Partial work survives.')],
          },
          {
            // @ts-expect-error - `data` is never null in the declared type.
            info: assistantMessage({ id: 'msg_datanull', error: { name: 'APIError', data: null } }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      // Every readable message survived — the conversation is intact.
      expect(history.map((m) => m.id)).toEqual([
        'msg_ask',
        'msg_said',
        'msg_nodata',
        'msg_null',
        'msg_datanull',
      ]);
      expect(history[1]!.content).toBe('Here is the answer.');
      // A nameable failure still names itself rather than disappearing.
      expect(history[2]!.parts).toEqual([
        { type: 'error', message: 'APIError', category: 'execution_error' },
      ]);
      // A null error is no error: the message keeps only its own text.
      expect(history[3]!.parts?.map((p) => p.type)).toEqual(['text']);
      expect(history[4]!.parts).toEqual([
        { type: 'error', message: 'APIError', category: 'execution_error' },
      ]);
    });

    it('re-lists to recover a derived binding in a fresh mapper (post-restart)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_prev' })] });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hello again')] }],
      });

      // First process: the session surfaces through list with a derived id.
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );

      // Second process: fresh in-memory map, same OpenCode server (source of truth).
      const fresh = new OpenCodeSessionMapper(createProvider(client));
      const history = await fresh.getMessageHistory(PROJECT_DIR, listed!.id);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_prev' } });
      expect(history[0]!.content).toBe('hello again');
    });

    it('rebinds a subfolder session after a restart, so a listed row still opens (DOR-674)', async () => {
      const client = createMockClient();
      const subDir = `${PROJECT_DIR}/packages/api`;
      // Directory-aware: with a mock that ignores `directory`, this rebuild
      // would resolve the id whether or not it asked the sidecar to widen.
      serveSessions(client, [ocSession({ id: 'ses_sub', directory: subDir })]);
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hi')] }],
      });
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );

      // A FRESH mapper is the post-restart state: the derived id has to be
      // re-minted from a re-list. If that re-list were still scoped to the
      // exact project dir, the row the list just showed would fail to open.
      const history = await new OpenCodeSessionMapper(createProvider(client)).getMessageHistory(
        PROJECT_DIR,
        listed!.id
      );

      expect(history).toHaveLength(1);
    });
  });
});
