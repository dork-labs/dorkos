import fs from 'fs/promises';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { DataProviderContext } from '@dorkos/extension-api/server';

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
  const originalSchedule = ctx.schedule;
  const originalEmit = ctx.emit;
  return {
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
  };
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
