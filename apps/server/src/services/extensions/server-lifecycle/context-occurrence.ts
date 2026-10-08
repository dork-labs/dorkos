import fs from 'fs/promises';
import { invokeOriginalNotification, scopeContextCapabilities } from './context-capabilities.js';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { AccountAdvisor, DataProviderContext } from '@dorkos/extension-api/server';

/** Capture an original facade method and fence only entry and successful return. */
function fence<Args extends unknown[], Result>(
  receiver: unknown,
  original: (...args: Args) => Promise<Result>,
  requireCurrent: () => void,
  ownOriginal: <T>(enter: () => Promise<T>) => Promise<T>
): (...args: Args) => Promise<Result> {
  return async (...args) =>
    ownOriginal(async () => {
      requireCurrent();
      const result = await original.apply(receiver, args);
      requireCurrent();
      return result;
    });
}

/** Scope existing facades to their constructor's original in-process occurrence. */
export function scopeContextOccurrence(
  ctx: DataProviderContext,
  requireCurrent: () => void,
  retainOriginal?: <T>(enter: () => Promise<T>) => Promise<T>
): DataProviderContext {
  const ownOriginal = retainOriginal ?? (<T>(enter: () => Promise<T>) => enter());
  const { accounts, projects, inbox, projectSettings, settings, storage, agent, sessions } = ctx;
  const originalLoad: typeof storage.loadData = storage.loadData.bind(storage);
  const originalSave: typeof storage.saveData = storage.saveData.bind(storage);
  const originalSetting: typeof settings.get = settings.get.bind(settings);
  const originalGet: typeof projectSettings.get = projectSettings.get.bind(projectSettings);
  const originalOnUsage = accounts.onUsage.bind(accounts);
  const originalRegisterAdvisor = accounts.registerAdvisor.bind(accounts);
  const originalSchedule = ctx.schedule;
  const originalEmit = ctx.emit;
  return scopeContextCapabilities(
    {
      ...ctx,
      storage: {
        async loadData<T = unknown>() {
          return ownOriginal(() => originalLoad<T>());
        },
        async saveData<T = unknown>(data: T) {
          return ownOriginal(() => originalSave(data));
        },
      },
      agent: { ...agent, send: fence(agent, agent.send, requireCurrent, ownOriginal) },
      sessions: { start: fence(sessions, sessions.start, requireCurrent, ownOriginal) },
      settings: {
        async get<T extends string | number | boolean = string | number | boolean>(
          key: string
        ): Promise<T | null> {
          return ownOriginal(async () => {
            requireCurrent();
            const result = await originalSetting<T>(key);
            requireCurrent();
            return result;
          });
        },
        set: fence(settings, settings.set, requireCurrent, ownOriginal),
        delete: fence(settings, settings.delete, requireCurrent, ownOriginal),
        getAll: fence(settings, settings.getAll, requireCurrent, ownOriginal),
      },
      accounts: {
        ...accounts,
        list: fence(accounts, accounts.list, requireCurrent, ownOriginal),
        usage: fence(accounts, accounts.usage, requireCurrent, ownOriginal),
        markContinued: fence(accounts, accounts.markContinued, requireCurrent, ownOriginal),
        onUsage(listener) {
          requireCurrent();
          if (typeof listener !== 'function') return originalOnUsage(listener);
          return originalOnUsage((usage) =>
            invokeOriginalNotification(undefined, listener, [usage], requireCurrent, ownOriginal)
          );
        },
        registerAdvisor(advisor) {
          requireCurrent();
          const guarded = captureAdvisor(advisor, requireCurrent, ownOriginal);
          requireCurrent();
          return originalRegisterAdvisor(guarded);
        },
      },
      projects: {
        ...projects,
        list: fence(projects, projects.list, requireCurrent, ownOriginal),
        resolve: fence(projects, projects.resolve, requireCurrent, ownOriginal),
        report: fence(projects, projects.report, requireCurrent, ownOriginal),
      },
      inbox: {
        ...inbox,
        raise: fence(inbox, inbox.raise, requireCurrent, ownOriginal),
        resolve: fence(inbox, inbox.resolve, requireCurrent, ownOriginal),
        record: fence(inbox, inbox.record, requireCurrent, ownOriginal),
        list: fence(inbox, inbox.list, requireCurrent, ownOriginal),
      },
      projectSettings: {
        ...projectSettings,
        async get<T = unknown>(root: string): Promise<T | null> {
          return ownOriginal(async () => {
            requireCurrent();
            const result = await originalGet<T>(root);
            requireCurrent();
            return result;
          });
        },
      },
      schedule(interval, original) {
        requireCurrent();
        return originalSchedule.call(ctx, interval, async () =>
          ownOriginal(async () => {
            requireCurrent();
            await original();
            requireCurrent();
          })
        );
      },
      emit(event, data) {
        const args: [string, unknown] = [event, data];
        requireCurrent();
        originalEmit.apply(ctx, args);
      },
    },
    requireCurrent,
    ownOriginal
  );
}

/** Keep original storage outcomes and fence the original write/read boundaries. */
export function createContextStorage(
  dataPath: string,
  requireCurrent: () => void
): DataProviderContext['storage'] {
  return {
    async loadData<T = unknown>(): Promise<T | null> {
      requireCurrent();
      let result: T | null;
      try {
        const raw = await fs.readFile(dataPath, 'utf-8');
        result = JSON.parse(raw) as T;
      } catch {
        result = null;
      }
      requireCurrent();
      return result;
    },
    async saveData<T = unknown>(data: T): Promise<void> {
      requireCurrent();
      const serialized = JSON.stringify(data, null, 2);
      requireCurrent();
      await writeFileAtomic(dataPath, serialized);
      requireCurrent();
    },
  };
}

/** Retain the first exact private admission refusal, even if a later lookup would succeed. */
export function captureContextCurrentness(
  receiver: unknown,
  original: (() => void) | undefined,
  isDisposed: () => boolean
): () => void {
  let refusal: { value: unknown } | undefined;
  return () => {
    if (!original) return;
    if (refusal) throw refusal.value;
    try {
      original.call(receiver);
      if (isDisposed()) throw new Error('Extension server context was retired.');
    } catch (value) {
      refusal = { value };
      throw value;
    }
  };
}

/** Capture each original advisor port; entered work belongs to the same retirement bank. */
function captureAdvisor(
  advisor: AccountAdvisor,
  requireCurrent: () => void,
  ownOriginal: <T>(enter: () => Promise<T>) => Promise<T>
): AccountAdvisor {
  const rank = advisor?.rank;
  // Preserve the existing registration validator for a malformed runtime value.
  if (typeof rank !== 'function') return { rank };
  const read = <Key extends Exclude<keyof AccountAdvisor, 'rank'>>(
    name: Key
  ): AccountAdvisor[Key] => {
    requireCurrent();
    return advisor[name];
  };
  const onLimited = read('onLimited');
  const modelFallback = read('modelFallback');
  const carryOver = read('carryOver');
  const claims = read('claims');
  const move = read('move');
  const cancelAuto = read('cancelAuto');
  const wait = read('wait');
  const wrap =
    <Args extends unknown[], Result>(
      method: (...args: Args) => Result
    ): ((...args: Args) => Promise<Awaited<Result>>) =>
    async (...args): Promise<Awaited<Result>> =>
      await ownOriginal<Awaited<Result>>(async (): Promise<Awaited<Result>> => {
        requireCurrent();
        const result = await method.apply(advisor, args);
        requireCurrent();
        return result;
      });
  return {
    rank: wrap(rank),
    ...(onLimited === undefined
      ? {}
      : { onLimited: typeof onLimited === 'function' ? wrap(onLimited) : onLimited }),
    ...(modelFallback === undefined
      ? {}
      : {
          modelFallback: typeof modelFallback === 'function' ? wrap(modelFallback) : modelFallback,
        }),
    ...(carryOver === undefined
      ? {}
      : { carryOver: typeof carryOver === 'function' ? wrap(carryOver) : carryOver }),
    ...(claims === undefined
      ? {}
      : { claims: typeof claims === 'function' ? wrap(claims) : claims }),
    ...(move === undefined ? {} : { move: typeof move === 'function' ? wrap(move) : move }),
    ...(cancelAuto === undefined
      ? {}
      : { cancelAuto: typeof cancelAuto === 'function' ? wrap(cancelAuto) : cancelAuto }),
    ...(wait === undefined ? {} : { wait: typeof wait === 'function' ? wrap(wait) : wait }),
  };
}
