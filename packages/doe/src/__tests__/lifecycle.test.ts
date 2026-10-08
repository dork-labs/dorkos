import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doe } from '../doe.js';
import { SqliteModelStore } from '../store.js';
import { DeferredToolRegistry } from '../registry/registry.js';
import type { DoeConfig, DoeEvent } from '../contracts.js';
import type { Engine } from '../engine.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
for (const operation of ['run', 'beat'] as const)
  for (const table of ['messages', 'usage'] as const)
    it(`${operation} late owned-child ${table} persistence failure rejects parent and suppresses completion`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'doe-owned-persistence-'));
      cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
      const file = join(directory, 'history.sqlite');
      const store = new SqliteModelStore(file);
      cleanups.push(() => store.close());
      const database = new Database(file);
      database.exec(
        `CREATE TRIGGER reject_child BEFORE INSERT ON ${table} WHEN NEW.scope = 'child:late' BEGIN SELECT RAISE(ABORT, 'child storage failed'); END;`
      );
      database.close();
      const events: DoeEvent[] = [];
      const config: DoeConfig = {
        sessionId: 'failure',
        workingDirectory: directory,
        store,
        registry: new DeferredToolRegistry(),
        pathPolicy: { readRoots: [], writeRoots: [] },
        resources: {
          load: async () => '',
          beforeFile: async () => '',
          skills: async () => [],
          loadSkill: async () => '',
        },
        model: {
          protocol: 'openai-completions',
          endpoint: 'http://127.0.0.1/v1',
          id: 'offline',
          contextWindow: 1000,
          maxOutputTokens: 100,
          payer: 'host',
          historyFamily: 'chat',
          credentials: async () => undefined,
        },
        onEvent: (event) => events.push(event),
      };
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const childController = new AbortController();
      const requested = new AbortController();
      let childFailure: unknown;
      const factory = (): Engine => ({
        run: async (request) => {
          if (request.context.scope === 'main') {
            void request.context.execute!({
              scope: 'child:late',
              purpose: 'builder',
              prompt: 'child',
              messages: [],
              tools: [],
              signal: childController.signal,
            }).catch(() => {});
            await started;
            childController.abort();
            return { messages: [], scope: 'main', stopReason: 'stop' };
          }
          entered();
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          );
          await new Promise((resolve) => setImmediate(resolve));
          // Fatal storage failure must retain precedence over a host cancellation during drain.
          requested.abort();
          try {
            await request.onUsage({
              requestId: 'child-late-usage',
              inputTokens: 12,
              outputTokens: 3,
            });
            await request.onMessage({ role: 'assistant', content: 'cleanup message' });
          } catch (error) {
            childFailure = error;
            throw error;
          }
          return { messages: [], scope: request.context.scope, stopReason: 'aborted' };
        },
        abort: () => {},
        steer: () => 'idle',
        followUp: () => 'idle',
      });
      config.extensions = {
        runBeat: async (_request, context) => {
          void context
            .execute({
              scope: 'child:late',
              purpose: 'builder',
              prompt: 'child',
              messages: [],
              tools: [],
              signal: childController.signal,
            })
            .catch(() => {});
          await started;
          childController.abort();
          return { kind: 'quiet' };
        },
      };
      const doe = new Doe(config, factory);
      const result = await (
        operation === 'run'
          ? doe.run('work', { signal: requested.signal })
          : doe.runBeat({ id: 'late', prompt: 'check', signal: requested.signal })
      ).catch((error) => error);
      expect(result).toBe(childFailure);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('child storage failed');
      expect(events.filter((event) => event.type === 'complete')).toEqual([]);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        {
          type: 'error',
          scope: operation === 'run' ? 'main' : 'beat:late',
          error: 'child storage failed',
        },
      ]);
      expect(store.usage('failure', 'child:late')).toHaveLength(table === 'usage' ? 0 : 1);
      expect(store.archive('failure', 'child:late')).toEqual([]);
      expect(store.outcomes('failure', 'beat:late')).toEqual([]);
      expect((await doe.run('next')).stopReason).toBe('stop');
      expect(events.at(-1)).toMatchObject({ type: 'complete', scope: 'main' });
    });

for (const kind of ['skipped', 'quiet', 'raises', 'outcome-failure'] as const)
  it(`facade owns durable beat finalization: ${kind}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'doe-beat-finalizer-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'history.sqlite');
    const store = new SqliteModelStore(file);
    cleanups.push(() => store.close());
    const events: DoeEvent[] = [];
    const result: import('../contracts.js').BeatResult =
      kind === 'skipped'
        ? { kind, reason: 'unchanged' }
        : kind === 'raises'
          ? { kind, raises: [{ message: 'review order', rung: 'report' }] }
          : { kind: 'quiet' };
    const config: DoeConfig = {
      sessionId: 'beat-finalizer',
      workingDirectory: '/tmp',
      store,
      registry: new DeferredToolRegistry(),
      pathPolicy: { readRoots: [], writeRoots: [] },
      resources: {
        load: async () => '',
        beforeFile: async () => '',
        skills: async () => [],
        loadSkill: async () => '',
      },
      model: {
        protocol: 'openai-completions',
        endpoint: 'http://127.0.0.1/v1',
        id: 'offline',
        contextWindow: 1000,
        maxOutputTokens: 100,
        payer: 'host',
        historyFamily: 'chat',
        credentials: async () => undefined,
      },
      onEvent: (event) => events.push(event),
      extensions: { runBeat: async () => result },
    };
    if (kind === 'outcome-failure') {
      const database = new Database(file);
      database.exec(
        "CREATE TRIGGER reject_outcome BEFORE INSERT ON outcomes BEGIN SELECT RAISE(ABORT, 'outcome disk failed'); END;"
      );
      database.close();
      await expect(new Doe(config).runBeat({ id: kind, prompt: 'check' })).rejects.toThrow(
        'outcome disk failed'
      );
      expect(store.outcomes(config.sessionId, `beat:${kind}`)).toEqual([]);
      expect(events).toEqual([
        { type: 'error', scope: `beat:${kind}`, error: 'outcome disk failed' },
      ]);
      return;
    }
    expect(await new Doe(config).runBeat({ id: kind, prompt: 'check' })).toEqual(result);
    expect(store.outcomes(config.sessionId, `beat:${kind}`).map((record) => record.result)).toEqual(
      [result]
    );
    expect(events.filter((event) => event.type === 'complete')).toEqual([
      { type: 'complete', scope: `beat:${kind}` },
    ]);
  });

for (const operation of ['run', 'beat'] as const)
  for (const cancellation of ['external', 'public', 'none'] as const)
    it(`${operation} ${cancellation} cancellation during owned drain preserves accounting and gates success`, async () => {
      const store = new SqliteModelStore(':memory:');
      cleanups.push(() => store.close());
      const events: DoeEvent[] = [];
      const config: DoeConfig = {
        sessionId: 'drain-cancel',
        workingDirectory: '/tmp',
        store,
        registry: new DeferredToolRegistry(),
        pathPolicy: { readRoots: [], writeRoots: [] },
        resources: {
          load: async () => '',
          beforeFile: async () => '',
          skills: async () => [],
          loadSkill: async () => '',
        },
        model: {
          protocol: 'openai-completions',
          endpoint: 'http://127.0.0.1/v1',
          id: 'offline',
          contextWindow: 1000,
          maxOutputTokens: 100,
          payer: 'host',
          historyFamily: 'chat',
          credentials: async () => undefined,
        },
        onEvent: (event) => events.push(event),
      };
      let entered!: () => void, draining!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const drainStarted = new Promise<void>((resolve) => {
        draining = resolve;
      });
      const drainGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const launch = async (
        execute: NonNullable<import('../contracts.js').ToolContext['execute']>
      ) => {
        void execute({
          scope: 'child:held',
          purpose: 'builder',
          prompt: '',
          messages: [],
          tools: [],
        }).catch(() => {});
        await started;
      };
      config.extensions = {
        runBeat: async (_request, context) => {
          await launch(context.execute);
          return { kind: 'quiet' };
        },
      };
      const factory = (): Engine => ({
        run: async (request) => {
          if (request.context.scope === 'main') {
            await launch(request.context.execute!);
            return { messages: [], scope: 'main', stopReason: 'stop' };
          }
          entered();
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          );
          draining();
          await drainGate;
          await request.onUsage({ requestId: 'held-child', inputTokens: 12 });
          return { messages: [], scope: request.context.scope, stopReason: 'aborted' };
        },
        abort: () => {},
        steer: () => 'idle',
        followUp: () => 'idle',
      });
      const doe = new Doe(config, factory);
      doe.abort(); // Idle cancellation must not affect a later operation.
      const controller = new AbortController();
      const pending = (
        operation === 'run'
          ? doe.run('work', { signal: controller.signal })
          : doe.runBeat({ id: 'held', prompt: 'check', signal: controller.signal })
      ).catch((error) => error);
      await drainStarted;
      await expect(new Doe(config, factory).run('overlap')).rejects.toThrow('active');
      if (cancellation === 'external') controller.abort();
      if (cancellation === 'public') doe.abort();
      release();
      const result = await pending;
      const scope = operation === 'run' ? 'main' : 'beat:held';
      expect(store.allUsage(config.sessionId)).toHaveLength(1);
      if (cancellation === 'none') {
        expect(operation === 'run' ? result.stopReason : result.kind).toBe(
          operation === 'run' ? 'stop' : 'quiet'
        );
        expect(events.filter((event) => event.type === 'complete')).toEqual([
          { type: 'complete', scope },
        ]);
        expect(store.outcomes(config.sessionId, 'beat:held')).toHaveLength(
          operation === 'beat' ? 1 : 0
        );
      } else {
        expect(result).toMatchObject({ name: 'AbortError' });
        expect(store.outcomes(config.sessionId, 'beat:held')).toEqual([]);
        expect(events.filter((event) => event.type === 'complete')).toEqual([]);
        expect(events.filter((event) => event.type === 'aborted')).toEqual([
          expect.objectContaining({ type: 'aborted', scope }),
        ]);
      }
    });
