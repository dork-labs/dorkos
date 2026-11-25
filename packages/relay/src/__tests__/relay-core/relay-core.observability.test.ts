import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventEmitter } from 'node:events';
import { RelayCore } from '../../relay-core.js';
import type { TraceStoreLike, RelayLogger } from '../../types.js';
import { applyRelayCoreTimeouts, makeTmpDir } from './relay-core.fixtures.js';

applyRelayCoreTimeouts();

/** Reach into the private chokidar config watcher to simulate an EMFILE-style failure. */
function getConfigWatcher(core: RelayCore): EventEmitter {
  return (core as unknown as { configWatcher: EventEmitter }).configWatcher;
}

/** A spy logger satisfying the full {@link RelayLogger} surface. */
function createSpyLogger(): RelayLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Trace store integration
// ---------------------------------------------------------------------------

describe('trace store integration', () => {
  let traceTmpDir: string;
  let traceRelay: RelayCore;
  let mockTraceStore: TraceStoreLike;

  beforeEach(async () => {
    traceTmpDir = await makeTmpDir('relay-trace-test-');
    mockTraceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() };
    traceRelay = new RelayCore({
      dataDir: traceTmpDir,
      traceStore: mockTraceStore,
    });
  });

  afterEach(async () => {
    await traceRelay.close();
    await fs.rm(traceTmpDir, { recursive: true, force: true });
  });

  it('records trace span when traceStore is provided', async () => {
    await traceRelay.registerEndpoint('relay.test.subject');
    await traceRelay.publish(
      'relay.test.subject',
      { content: 'hello' },
      { from: 'relay.test.sender', replyTo: 'relay.test.sender' }
    );

    expect(mockTraceStore.insertSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'relay.test.subject',
        status: 'delivered',
      })
    );
  });

  // A subject nobody listens on is not a failure — nothing broke and nothing
  // needs fixing. Recording it as one produced thousands of rows claiming
  // failure with no error attached (DOR-789).
  it('records a no_subscriber trace span for a message nothing was listening for', async () => {
    await traceRelay.publish(
      'relay.nowhere.subject',
      { content: 'lost' },
      { from: 'relay.test.sender', replyTo: 'relay.test.sender' }
    );

    expect(mockTraceStore.insertSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'no_subscriber',
      })
    );
  });

  it('records a failed trace span, with the reason, when a gate refuses the message', async () => {
    await traceRelay.publish(
      'relay.test.gated',
      { content: 'nope' },
      { from: 'relay.test.sender', budget: { hopCount: 9, maxHops: 5 } }
    );

    expect(mockTraceStore.insertSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('max hops'),
        metadata: expect.objectContaining({ budgetCode: 'hop_limit' }),
      })
    );
  });

  it('includes delivery metadata in trace span', async () => {
    await traceRelay.registerEndpoint('relay.test.meta');
    await traceRelay.publish('relay.test.meta', { content: 'meta' }, { from: 'relay.test.sender' });

    const call = (mockTraceStore.insertSpan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.metadata).toEqual(
      expect.objectContaining({
        // The sender is how the observed-chats list tells a message a chat
        // connection brought in from the agent's replies to it (DOR-2590).
        from: 'relay.test.sender',
        deliveredTo: 1,
        rejectedCount: 0,
        hasAdapterResult: false,
      })
    );
    expect(typeof call.metadata.durationMs).toBe('number');
  });

  it('does not fail publish when traceStore.insertSpan throws', async () => {
    (mockTraceStore.insertSpan as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('trace DB down');
    });

    await traceRelay.registerEndpoint('relay.test.trace-error');
    const result = await traceRelay.publish(
      'relay.test.trace-error',
      { content: 'ok' },
      { from: 'relay.test.sender' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(mockTraceStore.insertSpan).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config watcher error handling — an EMFILE-style watcher failure must be
// logged, never swallowed nor left to the process-wide unhandled-error path.
// ---------------------------------------------------------------------------

describe('config watcher error handling', () => {
  let cTmpDir: string;

  beforeEach(async () => {
    cTmpDir = await makeTmpDir('relay-core-cfgwatch-test-');
  });

  afterEach(async () => {
    await fs.rm(cTmpDir, { recursive: true, force: true });
  });

  it('logs a watcher error through the injected logger, naming the config path, and keeps working', async () => {
    const logger = createSpyLogger();
    const cRelay = new RelayCore({ dataDir: cTmpDir, logger });
    try {
      const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      getConfigWatcher(cRelay).emit('error', err);

      // Two separate assertions rather than one interpolated RegExp: the config
      // path is a real filesystem path and could legally contain regex
      // metacharacters that would silently change what the pattern matches.
      const [message, context] = vi.mocked(logger.warn).mock.calls[0]!;
      expect(typeof message).toBe('string');
      expect((message as string).startsWith('[watcher-error] RelayCore: ')).toBe(true);
      expect(message).toContain(path.join(cTmpDir, 'config.json'));
      expect(context).toEqual(
        expect.objectContaining({
          code: 'EMFILE',
          message: 'EMFILE: too many open files',
          stack: err.stack,
          suppressingFurtherErrors: true,
        })
      );

      // The relay itself is unaffected — it keeps operating on its last-loaded
      // reliability config; only hot-reload of external edits is degraded.
      await expect(cRelay.registerEndpoint('relay.agent.still-works')).resolves.toBeDefined();
    } finally {
      await cRelay.close();
    }
  });

  // A single fd-exhaustion episode can make chokidar fire 'error' many times
  // for one dead watcher. The handler must latch: log the first, drop repeats
  // of the same code.
  it('logs only the first of many errors carrying the same code', async () => {
    const logger = createSpyLogger();
    const cRelay = new RelayCore({ dataDir: cTmpDir, logger });
    try {
      const watcher = getConfigWatcher(cRelay);
      watcher.emit('error', Object.assign(new Error('EMFILE 1'), { code: 'EMFILE' }));
      watcher.emit('error', Object.assign(new Error('EMFILE 2'), { code: 'EMFILE' }));
      watcher.emit('error', Object.assign(new Error('EMFILE 3'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
      );
    } finally {
      await cRelay.close();
    }
  });

  // The masking bug: a latch keyed on "any error at all" would let one benign
  // EACCES hide a real EMFILE storm that follows it. Keying on `code` means a
  // NEW code always gets its own line.
  it('logs a separate line for each distinct error code', async () => {
    const logger = createSpyLogger();
    const cRelay = new RelayCore({ dataDir: cTmpDir, logger });
    try {
      const watcher = getConfigWatcher(cRelay);
      watcher.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      watcher.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EACCES' })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE' })
      );
    } finally {
      await cRelay.close();
    }
  });
});
