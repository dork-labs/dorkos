/** Fixed external-provider DATA seam; never a native issuer or replacement runtime. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type {
  Options,
  SDKMessage,
  Query,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';

let acquired = false;
let selectedSession: string | undefined;
let selectedFragments: readonly string[] = Object.freeze(['green']);
const originalObservedSessions = new Map<string, readonly string[]>();
const originalQueryMessages = new Map<string, () => void>();
/** Observe the real provider prompt while its owning Room claim is current. */
export function observeOriginalClaudeQueryMessage(sessionId: string, observed: () => void) {
  assert.equal(originalQueryMessages.has(sessionId), false);
  originalQueryMessages.set(sessionId, observed);
}
const homeInputs: Readonly<{ sessionId: string; cwd?: string; resume?: string }>[] = [];
/** Copied external query DATA; no request, stream, or issuer escapes. */
export function readOriginalClaudeSdkHomeInputs() {
  return Object.freeze([...homeInputs]);
}
const entries: { settled: Promise<void>; close: () => void }[] = [];

/** Install before importing the real runtime and original native fixture. */
export function installOriginalClaudeSdkDataObservation() {
  assert.equal(acquired, false);
  acquired = true;
  let sdkUrl: string | undefined;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (specifier === '@anthropic-ai/claude-agent-sdk') {
        if (sdkUrl) assert.equal(result.url, sdkUrl);
        sdkUrl = result.url;
      }
      return result;
    },
    load(url, context, nextLoad) {
      if (url !== sdkUrl) return nextLoad(url, context);
      // Every other original export remains the installed SDK's real export.
      // Only provider query is scripted; all application/native modules load unchanged.
      return {
        format: 'module',
        shortCircuit: true,
        source:
          `export * from ${JSON.stringify(url + '?original-sdk-data')};\n` +
          `export { query } from ${JSON.stringify(import.meta.url)};\n`,
      };
    },
  });
  let closed: Promise<void> | undefined;
  return {
    entries,
    /** Import-only registry loading must not acquire the provider package. */
    requireNotAcquired() {
      assert.equal(sdkUrl, undefined, 'Original registry import acquired the Claude SDK eagerly');
    },
    close() {
      if (closed) return closed;
      closed = Promise.resolve().then(async () => {
        let failed = false;
        let first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        // Initiate every acquired provider close before joining any of them.
        for (const entry of entries) {
          try {
            entry.close();
          } catch (cause) {
            remember(cause);
          }
        }
        const results = await Promise.allSettled(entries.map((entry) => entry.settled));
        for (const result of results) if (result.status === 'rejected') remember(result.reason);
        try {
          hooks.deregister();
        } catch (cause) {
          remember(cause);
        }
        if (failed) throw first;
      });
      return closed;
    },
  };
}

/** Fixed scenario data supplied only after a real current session is allocated. */
export function observeOriginalClaudeSession(
  sessionId: string,
  fragments: readonly string[] = ['green']
) {
  assert.ok(sessionId);
  const previous = originalObservedSessions.get(sessionId);
  if (previous) assert.deepEqual(fragments, previous);
  else originalObservedSessions.set(sessionId, Object.freeze([...fragments]));
  // Each original query snapshots this selected external DATA at construction.
  // Completed ordinary turns may precede a different genuine native session.
  selectedSession = sessionId;
  selectedFragments = originalObservedSessions.get(sessionId)!;
}

export function query(input: { prompt: string | AsyncIterable<unknown>; options: Options }): Query {
  assert.ok(acquired);
  // The real cache starts an empty asynchronous warmup query before a turn.
  // It asks supportedModels and closes it; it never needs a fabricated session.
  const sessionId = selectedSession;
  const fragments = selectedFragments;
  const prompt =
    typeof input.prompt === 'string' ? undefined : input.prompt[Symbol.asyncIterator]();
  let resolveSettled!: () => void;
  let rejectSettled!: (cause: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  void settled.catch(() => undefined);
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  let closing: Promise<void> | undefined;
  const usage: SDKResultSuccess['usage'] = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    inference_geo: 'not_applicable',
    iterations: [],
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
  const message = (text: string, outputTokens: number): SDKAssistantMessage['message'] => ({
    id: 'external-data',
    type: 'message',
    role: 'assistant',
    model: input.options.model ?? 'claude-haiku-4-5',
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason: outputTokens === 0 ? null : 'end_turn',
    stop_sequence: null,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    usage: { ...usage, output_tokens: outputTokens },
  });
  const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
    try {
      if (typeof input.prompt !== 'string') {
        assert.ok(prompt);
        for await (const _message of { [Symbol.asyncIterator]: () => prompt }) {
          assert.ok(sessionId, 'An actual current session must precede provider output');
          homeInputs.push(
            Object.freeze({
              sessionId,
              ...(input.options.cwd === undefined ? {} : { cwd: input.options.cwd }),
              ...(input.options.resume === undefined ? {} : { resume: input.options.resume }),
            })
          );
          assert.ok(input.options.cwd, 'The actual native query supplies its owned cwd');
          const observed = originalQueryMessages.get(sessionId);
          originalQueryMessages.delete(sessionId);
          observed?.();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            model: input.options.model ?? 'claude-haiku-4-5',
            permissionMode: input.options.permissionMode ?? 'default',
            tools: [],
            mcp_servers: [],
            slash_commands: [],
            output_style: 'normal',
            skills: [],
            plugins: [],
            cwd: input.options.cwd,
            apiKeySource: 'user',
            uuid: '00000000-0000-4000-8000-000000000001',
            claude_code_version: '0.0.0',
          } satisfies SDKSystemMessage;
          // The original mapper reads main-thread text only from SDK partial events.
          // Completed assistant/result messages carry metadata, not text_delta.
          let sdkSequence = 100;
          const partial = (
            event: SDKPartialAssistantMessage['event']
          ): SDKPartialAssistantMessage => ({
            type: 'stream_event',
            session_id: sessionId,
            parent_tool_use_id: null,
            uuid: `00000000-0000-4000-8000-${String(sdkSequence++).padStart(12, '0')}`,
            event,
          });
          yield partial({
            type: 'message_start',
            message: message('', 0),
          });
          yield partial({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '', citations: null },
          });
          for (const text of fragments)
            yield partial({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            });
          yield partial({ type: 'content_block_stop', index: 0 });
          yield partial({
            type: 'message_delta',
            delta: {
              stop_reason: 'end_turn',
              stop_sequence: null,
              container: null,
              stop_details: null,
            },
            context_management: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              fallback_credit: null,
              iterations: null,
              output_tokens_details: null,
              server_tool_use: null,
            },
          });
          yield partial({ type: 'message_stop' });
          yield {
            type: 'assistant',
            session_id: sessionId,
            parent_tool_use_id: null,
            uuid: '00000000-0000-4000-8000-000000000002',
            message: message(fragments.join(''), 1),
          } satisfies SDKAssistantMessage;
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            uuid: '00000000-0000-4000-8000-000000000003',
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: false,
            num_turns: 1,
            result: fragments.join(''),
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage,
            modelUsage: {},
            permission_denials: [],
          } satisfies SDKResultSuccess;
        }
      } else {
        throw new Error('Unexpected provider probe in original Room defaults case');
      }
    } catch (cause) {
      remember(cause);
      throw cause;
    } finally {
      if (!closing) {
        if (failed) rejectSettled(first);
        else resolveSettled();
      }
    }
  })();
  const close = () => {
    if (closing) return;
    closing = Promise.resolve().then(async () => {
      // HeldUserPrompt.return performs the original abandon+wakeup before its
      // join. Start that and output return independently; neither may pin the other.
      const joins: Promise<unknown>[] = [];
      try {
        if (prompt?.return) {
          const work = prompt.return();
          void work.catch(remember);
          joins.push(work);
        }
      } catch (cause) {
        remember(cause);
      }
      try {
        const work = iterator.return(undefined);
        void work.catch(remember);
        joins.push(work);
      } catch (cause) {
        remember(cause);
      }
      await Promise.allSettled(joins);
      if (failed) rejectSettled(first);
      else resolveSettled();
    });
    void closing.catch((cause) => {
      remember(cause);
      rejectSettled(first);
    });
  };
  entries.push({ settled, close });
  const unsupported = async (): Promise<never> => {
    throw new Error('Unsupported external SDK DATA control');
  };
  return Object.assign(iterator, {
    setMcpPermissionModeOverride: unsupported,
    setModel: unsupported,
    setMaxThinkingTokens: unsupported,
    applyFlagSettings: unsupported,
    updateSettings: unsupported,
    initializationResult: unsupported,
    reinitialize: unsupported,
    getContextUsage: unsupported,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: unsupported,
    readFile: unsupported,
    reloadSkills: unsupported,
    reloadOutputStyles: unsupported,
    accountInfo: unsupported,
    rewindFiles: unsupported,
    seedReadState: unsupported,
    reconnectMcpServer: unsupported,
    toggleMcpServer: unsupported,
    readMcpResource: unsupported,
    setMcpServers: unsupported,
    streamInput: unsupported,
    stopTask: unsupported,
    backgroundTasks: unsupported,
    supportedModels: async () => [],
    supportedCommands: async () => [],
    supportedAgents: async () => [],
    setPermissionMode: async () => undefined,
    mcpServerStatus: async () => [],
    close,
    interrupt: async () => undefined,
    reloadPlugins: async () => ({
      commands: [],
      agents: [],
      plugins: [],
      mcpServers: [],
      error_count: 0,
    }),
  }) satisfies Query;
}
