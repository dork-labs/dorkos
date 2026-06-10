import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

// Mock the SDK before importing the runtime (matches claude-code-runtime.test.ts).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  renameSession: vi.fn(),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import {
  getOrCreateProjector,
  disposeProjector,
  type SessionStateProjector,
} from '../../../session/index.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';

const HISTORY: HistoryMessage[] = [
  { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: 'hi there', timestamp: '2026-01-01T00:00:01.000Z' },
] as unknown as HistoryMessage[];

describe('ClaudeCodeRuntime session contract', () => {
  let runtime: ClaudeCodeRuntime;
  const sessionId = 'contract-session';

  beforeEach(() => {
    vi.clearAllMocks();
    disposeProjector(sessionId);
    runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/repo');
  });

  describe('getSessionSnapshot', () => {
    // Completed messages come from JSONL via getMessageHistory; cursor from the projector.
    it('assembles completed messages from getMessageHistory + projector cursor', async () => {
      const historySpy = vi.spyOn(runtime, 'getMessageHistory').mockResolvedValue(HISTORY);

      const projector = getOrCreateProjector(sessionId);
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'text_delta', text: 'streaming…' });

      const snapshot = await runtime.getSessionSnapshot({ permissionMode: 'default' }, sessionId);

      expect(historySpy).toHaveBeenCalledWith('/repo', sessionId);
      expect(snapshot.messages).toEqual(HISTORY);
      expect(snapshot.cursor).toBe(2);
      expect(snapshot.status.lifecycle).toBe('streaming');
      expect(snapshot.inProgressTurn).not.toBeNull();
    });

    // ctx.cwd overrides the runtime default when resolving the project dir.
    it('uses ctx.cwd as the project dir when provided', async () => {
      const historySpy = vi.spyOn(runtime, 'getMessageHistory').mockResolvedValue([]);
      await runtime.getSessionSnapshot({ permissionMode: 'default', cwd: '/other' }, sessionId);
      expect(historySpy).toHaveBeenCalledWith('/other', sessionId);
    });
  });

  describe('subscribeSession', () => {
    // Live events ingested into the projector are yielded with monotonic seq.
    it('yields projector events live', async () => {
      vi.spyOn(runtime, 'getMessageHistory').mockResolvedValue([]);
      const projector = getOrCreateProjector(sessionId);

      const iterator = runtime
        .subscribeSession({ permissionMode: 'default' }, sessionId)
        [Symbol.asyncIterator]();

      projector.ingest({ type: 'turn_start' });
      const first = await iterator.next();
      expect(first.value).toMatchObject({ type: 'turn_start', seq: 1 });

      projector.ingest({ type: 'text_delta', text: 'live' });
      const second = await iterator.next();
      expect(second.value).toMatchObject({ type: 'text_delta', text: 'live', seq: 2 });
    });

    // sinceCursor replays only the gap (events with a greater seq) before live.
    it('replays the gap after sinceCursor', async () => {
      const projector: SessionStateProjector = getOrCreateProjector(sessionId);
      projector.ingest({ type: 'turn_start' }); // seq 1
      projector.ingest({ type: 'text_delta', text: 'a' }); // seq 2
      projector.ingest({ type: 'text_delta', text: 'b' }); // seq 3

      const replayed: SessionEvent[] = [];
      const iterator = runtime
        .subscribeSession({ permissionMode: 'default' }, sessionId, 1)
        [Symbol.asyncIterator]();
      replayed.push((await iterator.next()).value);
      replayed.push((await iterator.next()).value);

      expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
      expect(replayed.map((e) => (e.type === 'text_delta' ? e.text : e.type))).toEqual(['a', 'b']);
    });
  });
});
