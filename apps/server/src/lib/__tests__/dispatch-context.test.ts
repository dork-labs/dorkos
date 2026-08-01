/**
 * The correlation spine's two halves, tested where they meet: the
 * AsyncLocalStorage carrier, and the file reporter that reads it.
 *
 * The reporter tests are the load-bearing ones. The claim this phase makes is
 * that **an existing log call, unedited, gains a `dispatchId` when it happens
 * inside a dispatch** — so the assertions here are made against `logger.info`
 * calls that pass no correlation field of their own, exactly as the hundreds of
 * call sites in the server do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs');

describe('dispatch context', () => {
  let fs: typeof import('fs');
  let loggerModule: typeof import('../logger.js');
  let dispatch: typeof import('../dispatch-context.js');

  /** Every NDJSON line the reporter has written this test, parsed. */
  function writtenLines(): Array<Record<string, unknown>> {
    return vi
      .mocked(fs.appendFileSync)
      .mock.calls.map((call) => JSON.parse(String(call[1]).trim()) as Record<string, unknown>);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fs = await import('fs');
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    loggerModule = await import('../logger.js');
    dispatch = await import('../dispatch-context.js');
    loggerModule.initLogger({ logDir: '/logs', level: 4 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('the carrier', () => {
    it('reports no dispatch outside one', () => {
      expect(dispatch.currentDispatch()).toBeUndefined();
      expect(dispatch.currentDispatchId()).toBeUndefined();
    });

    it('carries the context across an await chain', async () => {
      const seen = await dispatch.runInDispatch(
        { dispatchId: 'dsp_X', origin: 'room', entryId: 'entry-1' },
        async () => {
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 1));
          return dispatch.currentDispatch();
        }
      );
      expect(seen).toEqual({ dispatchId: 'dsp_X', origin: 'room', entryId: 'entry-1' });
      // And it does not leak back out.
      expect(dispatch.currentDispatch()).toBeUndefined();
    });

    it('nests, with the inner dispatch winning until it returns', () => {
      const order: Array<string | undefined> = [];
      dispatch.runInDispatch({ dispatchId: 'dsp_OUTER', origin: 'room' }, () => {
        order.push(dispatch.currentDispatchId());
        dispatch.runInDispatch({ dispatchId: 'dsp_INNER', origin: 'relay' }, () => {
          order.push(dispatch.currentDispatchId());
        });
        order.push(dispatch.currentDispatchId());
      });
      expect(order).toEqual(['dsp_OUTER', 'dsp_INNER', 'dsp_OUTER']);
    });
  });

  describe('the reporter', () => {
    it('adds the ambient id to a log call that never mentions one', () => {
      // The whole retrofit, in one assertion: this call site is unedited.
      dispatch.runInDispatch({ dispatchId: 'dsp_AMBIENT', origin: 'session' }, () => {
        loggerModule.logger.info('[rooms] an agent took a room turn', { roomId: 'r1' });
      });
      const [line] = writtenLines();
      expect(line.dispatchId).toBe('dsp_AMBIENT');
      expect(line.roomId).toBe('r1');
    });

    it('omits the field entirely outside a dispatch', () => {
      loggerModule.logger.info('[rooms] a room was halted', { roomId: 'r1' });
      const [line] = writtenLines();
      expect('dispatchId' in line).toBe(false);
    });

    it("lets an explicit id win, so a caller logging about ANOTHER dispatch isn't mislabelled", () => {
      dispatch.runInDispatch({ dispatchId: 'dsp_AMBIENT', origin: 'session' }, () => {
        loggerModule.logger.info('[rooms] an agent finished a room turn', {
          dispatchId: 'dsp_EXPLICIT',
        });
      });
      expect(writtenLines()[0].dispatchId).toBe('dsp_EXPLICIT');
    });

    it('lifts a leading [tag] into the tag field, leaving the message intact', () => {
      // `jq 'select(.tag=="rooms")'` is what `debug:logs` advertises; before
      // this it matched nothing, because `tag` was empty on every line that
      // used the string prefix — which is every line but three in the server.
      loggerModule.logger.warn('[stall-guard] no activity from the runtime', { sessionId: 's1' });
      const [line] = writtenLines();
      expect(line.tag).toBe('stall-guard');
      expect(line.msg).toBe('[stall-guard] no activity from the runtime');
    });

    it('does not mistake bracketed prose for a tag', () => {
      loggerModule.logger.info('[object Object] leaked into a message');
      loggerModule.logger.info('no tag here at all');
      loggerModule.logger.info('[rooms]no space after the tag');
      for (const line of writtenLines()) expect(line.tag).toBeUndefined();
    });

    it('keeps a createTaggedLogger tag when the message also opens with a bracket', () => {
      loggerModule.createTaggedLogger('scheduler').info('[rooms] borrowed prefix');
      expect(writtenLines()[0].tag).toBe('scheduler');
    });

    it('never reads the store for a line the level filter drops', async () => {
      // I6: a suppressed debug must cost nothing. Proven by counting reads of
      // the store itself rather than by asserting the absence of an output line,
      // which would pass even if the read happened.
      vi.resetModules();
      vi.clearAllMocks();
      const reads = { count: 0 };
      vi.doMock('../dispatch-context.js', async () => {
        const actual =
          await vi.importActual<typeof import('../dispatch-context.js')>('../dispatch-context.js');
        return {
          ...actual,
          currentDispatchId: () => {
            reads.count += 1;
            return actual.currentDispatchId();
          },
        };
      });
      const counted = await import('../logger.js');
      counted.initLogger({ logDir: '/logs', level: 3 }); // info; debug is filtered
      counted.logger.debug('[rooms] a per-event detail');
      expect(reads.count).toBe(0);
      counted.logger.info('[rooms] a lifecycle line');
      expect(reads.count).toBe(1);
      vi.doUnmock('../dispatch-context.js');
    });
  });
});
