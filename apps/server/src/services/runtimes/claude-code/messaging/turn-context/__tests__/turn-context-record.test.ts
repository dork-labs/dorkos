/**
 * Sealed: what the turn-context record holds for a Claude Code turn is
 * byte-equal to what the SDK's `query()` was handed: the append on
 * `options.systemPrompt`, and the prompt message. A mocked SDK, no CLI, no
 * network, no key.
 *
 * Each render of the append carries a fresh value here, the way a real render
 * carries a fresh fence nonce. So a record built by rendering again, rather
 * than by keeping what was sent, cannot match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { createTestDb } from '@dorkos/test-utils/db';
import { executeSdkQuery, type MessageSenderOpts } from '../../message-sender.js';
import { buildSystemPromptAppend } from '../../context-builder.js';
import {
  measureTurnStartUsage,
  noteLaunchedAppend,
  recordPumpTurnContext,
} from '../turn-context-record.js';
import type { AgentSession } from '../../../agent-types.js';
import { setTurnContextStore } from '../../../../../session/turn-context/record-turn-context.js';
import { TurnContextStore } from '../../../../../session/turn-context/turn-context-store.js';

const renders = vi.hoisted(() => ({ count: 0 }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn(async () => {
    renders.count += 1;
    const text = `<agent_identity>Made-up agent</agent_identity>\n<fence nonce="${renders.count}"/>`;
    return { text, stable: text };
  }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));

const GIT_BAG: AdditionalContext = [
  { kind: 'git_status', scope: 'per-turn', data: { isRepo: true, branch: 'main', clean: true } },
];

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

const senderOpts: MessageSenderOpts = { cwd: '/mock/project', onSdkSessionRebind: async () => {} };

let store: TurnContextStore;
beforeEach(() => {
  renders.count = 0;
  store = new TurnContextStore(createTestDb());
  setTurnContextStore(store);
});
afterEach(() => setTurnContextStore(null));

describe('Claude Code turn-context record', () => {
  it('records the exact append and prompt the SDK was handed on the per-turn path', async () => {
    let sentOptions: Options | undefined;
    let sentPrompt: AsyncIterable<{ message: { content: string } }> | undefined;
    vi.mocked(query).mockImplementation((args) => {
      sentOptions = args.options;
      sentPrompt = args.prompt as typeof sentPrompt;
      return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<
        typeof query
      >;
    });

    for await (const _ of executeSdkQuery('s1', 'hello world', makeSession(), senderOpts, {
      additionalContext: GIT_BAG,
      messageId: 'm-1',
    })) {
      // drain
    }

    const sentAppend = (sentOptions!.systemPrompt as { append: string }).append;
    const first = await sentPrompt![Symbol.asyncIterator]().next();
    const sentContent = (first.value as { message: { content: string } }).message.content;

    const [record] = store.listTurnContextsForSession('s1');
    expect(record).toMatchObject({
      runtime: 'claude-code',
      place: 'chat',
      messageId: 'm-1',
      permissionMode: sentOptions!.permissionMode,
      systemSentThisTurn: true,
    });
    expect(record!.parts.map((part) => part.slot)).toEqual(['system_append', 'prompt']);
    // Byte-equal to what the SDK received.
    expect(record!.parts[0]!.body).toBe(sentAppend);
    expect(record!.parts[1]!.body).toBe(sentContent);
    expect(sentContent).toBe('<git_status>mock</git_status>\n\nhello world');

    // The mutant: rendering the append again for the record gives other bytes.
    const again = await buildSystemPromptAppend(
      '/mock/project' as never,
      '/mock/project',
      {} as never
    );
    expect(again.text).not.toBe(record!.parts[0]!.body);
  });

  it('records the append a warm process holds, not the one a later turn resolved', () => {
    const session = makeSession();
    const launched = { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'A1' } };
    noteLaunchedAppend(session, launched as Options);

    recordPumpTurnContext(
      session,
      's1',
      'm-1',
      { enrichedContent: 'one', sdkOptions: launched as Options },
      undefined
    );
    // The second turn resolved a newer append (memory changed), but the warm
    // process still runs on the one it was launched with.
    const resolvedLater = { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'A2' } };
    recordPumpTurnContext(
      session,
      's1',
      'm-2',
      { enrichedContent: 'two', sdkOptions: resolvedLater as Options },
      undefined
    );

    const records = store.listTurnContextsForSession('s1');
    expect(records.map((r) => [r.systemSentThisTurn, r.parts[0]!.body, r.parts[1]!.body])).toEqual([
      [true, 'A1', 'one'],
      [false, 'A1', 'two'],
    ]);
    expect(records.map((r) => r.parts[0]!.bodyHash)).toEqual([
      records[0]!.parts[0]!.bodyHash,
      records[0]!.parts[0]!.bodyHash,
    ]);
  });

  it('stores the process’s own count of the context, measured at turn start', async () => {
    const session = makeSession();
    const answer = {
      model: 'claude-made-up',
      totalTokens: 1200,
      maxTokens: 200000,
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 900, kind: 'used', color: 'x' },
        { id: 'memory_files', name: 'Memory files', tokens: 300, kind: 'used', color: 'x' },
      ],
    };
    session.activeQuery = { getContextUsage: vi.fn(async () => answer) } as never;
    noteLaunchedAppend(session, {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'A' },
    } as Options);
    recordPumpTurnContext(
      session,
      's1',
      'm-1',
      { enrichedContent: 'hi', sdkOptions: {} as Options },
      undefined
    );

    await vi.waitFor(() => expect(store.listTurnContextsForSession('s1')[0]!.usage).not.toBeNull());
    expect(store.listTurnContextsForSession('s1')[0]!.usage).toEqual({
      kind: 'measured',
      at: 'turn_start',
      model: 'claude-made-up',
      totalTokens: 1200,
      maxTokens: 200000,
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 900, kind: 'used' },
        { id: 'memory_files', name: 'Memory files', tokens: 300, kind: 'used' },
      ],
    });
  });

  it('falls back to the estimate when the measured count is slow, and to nothing when both fail', async () => {
    const summary = { totalTokens: 10, maxTokens: 100, categories: [], model: '' };
    const slowFull = {
      getContextUsage: vi.fn(({ detail }: { detail: string }) =>
        detail === 'full' ? new Promise(() => {}) : Promise.resolve(summary)
      ),
    };
    const bounds = { fullMs: 5, summaryMs: 5 };
    expect(await measureTurnStartUsage(slowFull as never, bounds)).toMatchObject({
      kind: 'estimate',
      totalTokens: 10,
    });
    const broken = { getContextUsage: vi.fn(async () => Promise.reject(new Error('429'))) };
    expect(await measureTurnStartUsage(broken as never, bounds)).toBeNull();
    const throwsAtOnce = {
      getContextUsage: vi.fn(() => {
        throw new Error('closed');
      }),
    };
    expect(await measureTurnStartUsage(throwsAtOnce as never, bounds)).toBeNull();
  });
});
