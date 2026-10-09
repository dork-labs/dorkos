import type { DataProviderContext } from '@dorkos/extension-api/server';

type OwnOriginal = <T>(enter: () => Promise<T>) => Promise<T>;

/**
 * Reserve a notification's original work without changing synchronous delivery or its return value.
 *
 * @param receiver - Original callback receiver.
 * @param original - Captured notification callback.
 * @param args - Already prepared original callback arguments.
 * @param requireCurrent - Exact originating registration admission check.
 * @param ownOriginal - Existing original-work custody bank.
 * @returns The exact original callback value; throws its exact synchronous failure.
 */
export function invokeOriginalNotification<Args extends unknown[]>(
  receiver: unknown,
  original: (...args: Args) => unknown,
  args: Args,
  requireCurrent: () => void,
  ownOriginal: OwnOriginal
): unknown {
  try {
    requireCurrent();
  } catch {
    return;
  }
  const observed: { value?: unknown; synchronous?: { value: unknown } } = {};
  const returned = ownOriginal(() => {
    requireCurrent();
    try {
      observed.value = Reflect.apply(original, receiver, args);
    } catch (failure) {
      observed.synchronous = { value: failure };
      throw failure;
    }
    return Promise.resolve(observed.value).then((result) => {
      requireCurrent();
      return result;
    });
  });
  // Notification hosts are synchronous and may ignore an actual returned promise.
  // Its original settlement remains joined by the bank even when nobody awaits it.
  void returned.catch(() => undefined);
  if (observed.synchronous) throw observed.synchronous.value;
  return observed.value;
}

/**
 * Fence the remaining private context capabilities using their exact original receivers.
 *
 * @param ctx - Existing scoped context; already-fenced facades remain unchanged.
 * @param requireCurrent - Exact originating registration check.
 * @param ownOriginal - Original-work bank supplied by the registration owner.
 * @returns The context with private secret, notification, action and middleware fences.
 */
export function scopeContextCapabilities(
  ctx: DataProviderContext,
  requireCurrent: () => void,
  ownOriginal: OwnOriginal
): DataProviderContext {
  const { secrets, projects, projectSettings, inbox, agent, tools } = ctx;
  const secret =
    <Args extends unknown[], Result>(original: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> =>
      ownOriginal(async () => {
        requireCurrent();
        const result = await Reflect.apply(original, secrets, args);
        requireCurrent();
        return result;
      });
  const subscribe =
    <Args extends unknown[]>(
      receiver: unknown,
      original: (listener: (...args: Args) => void) => () => void
    ) =>
    (listener: (...args: Args) => void): (() => void) => {
      if (typeof listener !== 'function') {
        requireCurrent();
        return Reflect.apply(original, receiver, [listener]);
      }
      const delivered = function (this: unknown, ...args: Args) {
        return invokeOriginalNotification(this, listener, args, requireCurrent, ownOriginal);
      };
      requireCurrent();
      return Reflect.apply(original, receiver, [delivered]);
    };
  const originalAction = inbox.onAction;
  const originalPerson = ctx.requirePerson;
  const originalHandle = tools.handle;
  return {
    ...ctx,
    secrets: {
      get: secret(secrets.get),
      set: secret(secrets.set),
      delete: secret(secrets.delete),
      has: secret(secrets.has),
    },
    projects: { ...projects, onChange: subscribe(projects, projects.onChange) },
    projectSettings: {
      ...projectSettings,
      onChange: subscribe(projectSettings, projectSettings.onChange),
    },
    agent: { ...agent, subscribe: subscribe(agent, agent.subscribe) },
    inbox: {
      ...inbox,
      onAction(handler) {
        if (typeof handler !== 'function') {
          requireCurrent();
          return Reflect.apply(originalAction, inbox, [handler]);
        }
        const delivered: typeof handler = async function (this: unknown, ...args) {
          return ownOriginal(async () => {
            requireCurrent();
            const result = await Reflect.apply(handler, this, args);
            requireCurrent();
            return result;
          });
        };
        requireCurrent();
        return Reflect.apply(originalAction, inbox, [delivered]);
      },
    },
    tools: {
      handle(name, handler) {
        if (typeof handler !== 'function') {
          requireCurrent();
          return Reflect.apply(originalHandle, tools, [name, handler]);
        }
        const delivered: typeof handler = async function (this: unknown, ...args) {
          return ownOriginal(async () => {
            requireCurrent();
            const result = await Reflect.apply(handler, this, args);
            requireCurrent();
            return result;
          });
        };
        requireCurrent();
        return Reflect.apply(originalHandle, tools, [name, delivered]);
      },
    },
    requirePerson: async function (this: unknown, req, res, next) {
      const deliver: typeof next = (...args: unknown[]) => {
        // Error delivery never grants the next route; normal/skip-route delivery does.
        if (!args[0] || args[0] === 'route' || args[0] === 'router') requireCurrent();
        return Reflect.apply(next, undefined, args);
      };
      return ownOriginal(async () => {
        requireCurrent();
        return await Reflect.apply(originalPerson, this, [req, res, deliver]);
      });
    },
  };
}
