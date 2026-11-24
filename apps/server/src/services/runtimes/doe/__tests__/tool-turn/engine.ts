import type { Engine, EngineFactory, EngineRequest, EngineResult } from '@dorkos/doe';

/** Owned model-execution edge; the real Doe facade still assembles every request. */
export function scriptedEngine() {
  const runs: Array<{ request: EngineRequest; finish(reason?: EngineResult['stopReason']): void }> =
    [];
  const listeners = new Set<() => void>();
  const factory: EngineFactory = () =>
    ({
      async run(request) {
        let finish!: (reason: EngineResult['stopReason']) => void;
        const result = new Promise<EngineResult['stopReason']>((resolve) => {
          finish = resolve;
        });
        await request.prepareRequest?.(request.messages, request.signal);
        const entry = {
          request,
          finish: (reason: EngineResult['stopReason'] = 'stop') => finish(reason),
        };
        runs.push(entry);
        for (const notify of [...listeners]) notify();
        const aborted = () => finish('aborted');
        request.signal.addEventListener('abort', aborted, { once: true });
        if (request.signal.aborted) aborted();
        try {
          return { messages: [], scope: request.context.scope, stopReason: await result };
        } finally {
          request.signal.removeEventListener('abort', aborted);
        }
      },
      steer: () => 'queued',
      followUp: () => 'queued',
      abort() {},
    }) satisfies Engine;
  return {
    factory,
    runs,
    next(index: number) {
      if (runs[index]) return Promise.resolve(runs[index]);
      return new Promise<(typeof runs)[number]>((resolve) => {
        const notify = () => {
          if (runs[index]) {
            listeners.delete(notify);
            resolve(runs[index]);
          }
        };
        listeners.add(notify);
      });
    },
    close() {
      for (const run of runs) run.finish('aborted');
      listeners.clear();
    },
  };
}
