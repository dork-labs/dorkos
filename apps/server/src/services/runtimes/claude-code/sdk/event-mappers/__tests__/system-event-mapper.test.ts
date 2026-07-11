import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import { createToolState } from '../../../agent-types.js';
import { mapSystemEvent } from '../system-event-mapper.js';

vi.mock('../../../../../../lib/logger.js', () => ({
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

import { logger } from '../../../../../../lib/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-1';

/** Minimal AgentSession — the subtypes under test read neither session nor toolState. */
function makeSession(): AgentSession {
  return {
    sdkSessionId: '',
    lastActivity: 0,
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

/** Cast a loose object literal to the SDKMessage union for mapping. */
function sys(obj: Record<string, unknown>): SDKMessage {
  return obj as unknown as SDKMessage;
}

/** Drain the mapper's async generator into an array of StreamEvents. */
async function collect(
  message: SDKMessage,
  session: AgentSession = makeSession(),
  toolState: ToolState = createToolState()
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of mapSystemEvent(message, session, SESSION_ID, toolState)) {
    out.push(event);
  }
  return out;
}

describe('mapSystemEvent — DOR-108 subtypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('compact_boundary', () => {
    it('forwards the full compact_metadata camelCased', async () => {
      const events = await collect(
        sys({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'manual',
            pre_tokens: 51226,
            post_tokens: 4151,
            duration_ms: 63275,
          },
        })
      );

      expect(events).toEqual([
        {
          type: 'compact_boundary',
          data: { trigger: 'manual', preTokens: 51226, postTokens: 4151, durationMs: 63275 },
        },
      ]);
    });

    it('forwards only the fields the SDK supplies (partial metadata)', async () => {
      const events = await collect(
        sys({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 120000 },
        })
      );

      expect(events).toEqual([
        { type: 'compact_boundary', data: { trigger: 'auto', preTokens: 120000 } },
      ]);
    });

    it('falls back to empty data when compact_metadata is absent', async () => {
      const events = await collect(sys({ type: 'system', subtype: 'compact_boundary' }));
      expect(events).toEqual([{ type: 'compact_boundary', data: {} }]);
    });

    it('forwards zero token counts (guards the !== undefined check, not truthiness)', async () => {
      const events = await collect(
        sys({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual', pre_tokens: 0, post_tokens: 0 },
        })
      );

      expect(events).toEqual([
        { type: 'compact_boundary', data: { trigger: 'manual', preTokens: 0, postTokens: 0 } },
      ]);
    });
  });

  describe('status', () => {
    it('maps an in-flight compaction to an operation_progress started (DOR-110)', async () => {
      const events = await collect(
        sys({ type: 'system', subtype: 'status', status: 'compacting' })
      );
      expect(events).toEqual([
        {
          type: 'operation_progress',
          data: {
            operation: 'compaction',
            state: 'started',
            determinate: false,
            message: 'Compacting context…',
          },
        },
      ]);
    });

    it('maps a successful compaction resolution to operation_progress done', async () => {
      const events = await collect(
        sys({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('operation_progress');
      expect(events[0].data).toMatchObject({ operation: 'compaction', state: 'done' });
      expect(events[0].data).not.toHaveProperty('error');
    });

    it('maps a failed compaction resolution to operation_progress failed + error', async () => {
      const events = await collect(
        sys({
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          compact_error: 'context too large to summarize',
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('operation_progress');
      expect(events[0].data).toMatchObject({
        operation: 'compaction',
        state: 'failed',
        error: 'context too large to summarize',
      });
    });

    it('forwards a generic (non-compaction) status on the system_status channel', async () => {
      const events = await collect(
        sys({ type: 'system', subtype: 'status', status: 'requesting' })
      );
      expect(events).toEqual([
        { type: 'system_status', data: { message: 'Status: requesting', status: 'requesting' } },
      ]);
    });

    it('yields nothing when the status carries no renderable signal', async () => {
      const events = await collect(sys({ type: 'system', subtype: 'status', status: null }));
      expect(events).toEqual([]);
    });
  });

  describe('commands_changed', () => {
    it('is swallowed (no event, no unhandled-subtype debug log)', async () => {
      const events = await collect(
        sys({ type: 'system', subtype: 'commands_changed', commands: [] })
      );
      expect(events).toEqual([]);
      // It must NOT fall through to the catch-all unhandled-subtype log.
      const debugCalls = vi.mocked(logger.debug).mock.calls;
      const hitCatchAll = debugCalls.some((c) =>
        String(c[0]).includes('Unhandled SDK message type')
      );
      expect(hitCatchAll).toBe(false);
    });
  });
});
