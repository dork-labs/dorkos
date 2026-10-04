/**
 * The child half of `ctx` over the boundary (DOR-2686, spec §5): the
 * `DataProviderContext` an isolated extension's `register()` receives, built
 * member by member from the protocol table.
 *
 * - `const`: the values the host copied into `init`.
 * - `call`: a promise over `call`/`ret`.
 * - `emit`: one `emit` message, nothing back.
 * - `subscribe`: a `sub` message and a local listener; returns a function that
 *   sends `unsub`. Events arrive as `evt`.
 * - `reverse`: the function stays here under an id (`expose`); the host calls
 *   it with `rcall` and this answers with `rret`. A `cancel` drops that call's
 *   answer. (Its `AbortController` is aborted too, but no handler receives the
 *   signal yet: the advisor and the action handler take none. Tools will.)
 * - `local`: `schedule` (the same 5-second floor as in-process; every cancel
 *   runs on stop) and `requirePerson`, which refuses every request until the
 *   host's verdict header reaches the child (a later phase): fail closed.
 * - `refused`: throws the table's reason.
 *
 * Nothing here enforces anything: the extension shares this process, and
 * could send any message itself. The host checks every message
 * (`ctx-dispatcher.ts`). The proxy's job is to behave like the in-process ctx,
 * including errors: an error the host sends is rebuilt as the extension API's
 * own class (`AgentSendError`, `InboxLimitError`, `InboxLinkError`,
 * `StartWorkError`) by name, else an `Error`, with `code` and the other fields
 * copied.
 *
 * @module services/extensions/isolation/child/proxy-ctx
 */
import type { RequestHandler } from 'express';
import type { DataProviderContext } from '@dorkos/extension-api/server';
import {
  ADVISOR_METHODS,
  CTX_PROTOCOL,
  type Kind,
  type ReverseKind,
  type SubscribeKind,
} from '../ctx-protocol.js';
import type { ChildMessage, HostMessage, InitMessage, WireError } from '../ipc-protocol.js';

/** Minimum scheduling interval in seconds, as in-process. */
const MIN_INTERVAL_SECONDS = 5;

/** What an isolated extension without `allow.agents` is told (the host says the same). */
const AGENTS_REFUSAL = "This extension didn't ask to message your agents.";

/** The extension API's error classes, as bundled into the child. */
export interface ProxyErrorClasses {
  AgentSendError: new (code: never, message: string) => Error;
  InboxLimitError: new (limit: never, message: string) => Error;
  InboxLinkError: new (message: string) => Error;
  StartWorkError: new (code: never, message: string) => Error;
}

/** What {@link createProxyCtx} needs. */
export interface ProxyCtxDeps {
  /** Send one message to the host. Throws when the message cannot be serialized. */
  send: (message: ChildMessage) => void;
  /** The host's `init`. */
  init: Pick<InitMessage, 'extensionId' | 'ctx' | 'displayName' | 'allowAgents'>;
  /** The extension API's error classes. */
  errors: ProxyErrorClasses;
  /** Where to report a listener or task that threw (the host forwards stderr to its log). */
  log?: (message: string, err?: unknown) => void;
}

/** The proxy ctx and its controls. */
export interface ProxyCtx {
  /** What `register()` receives. */
  ctx: DataProviderContext;
  /**
   * Handle one message from the host if it is a ctx message.
   *
   * @returns `true` when it was one.
   */
  receive(message: HostMessage): boolean;
  /** Cancel every scheduled task (the first step of a stop). */
  cancelScheduled(): void;
  /** Stop: cancel every scheduled task and refuse every later call. */
  stop(): void;
}

/** A reverse handler held here: which function a method name means. */
interface Exposed {
  resolve(method: string): ((...args: unknown[]) => unknown) | undefined;
}

/**
 * Rebuild an error the host sent.
 *
 * @param error - The wire error.
 * @param classes - The extension API's error classes.
 */
export function rebuildError(error: WireError | undefined, classes: ProxyErrorClasses): Error {
  const message = typeof error?.message === 'string' ? error.message : 'Something went wrong.';
  const props = error?.props ?? {};
  let err: Error;
  switch (error?.name) {
    case 'AgentSendError':
      err = new classes.AgentSendError(error.code as never, message);
      break;
    case 'StartWorkError':
      err = new classes.StartWorkError(error.code as never, message);
      break;
    case 'InboxLimitError':
      err = new classes.InboxLimitError(props.limit as never, message);
      break;
    case 'InboxLinkError':
      err = new classes.InboxLinkError(message);
      break;
    default: {
      err = new Error(message);
      if (error?.name && error.name !== 'Error') err.name = error.name;
      if (error?.code !== undefined) {
        Object.defineProperty(err, 'code', {
          value: error.code,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  for (const key of Object.keys(props)) {
    if (key in err) continue;
    Object.defineProperty(err, key, {
      value: props[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return err;
}

/**
 * Turn anything a child handler threw into a wire error for an `rret`.
 *
 * @param err - What was thrown.
 */
function toWire(err: unknown): WireError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: typeof err.name === 'string' ? err.name : 'Error',
      message: String(err.message),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

/** Whether a value is a function the extension passed. */
function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/**
 * Build the proxy ctx.
 *
 * @param deps - See {@link ProxyCtxDeps}.
 */
export function createProxyCtx(deps: ProxyCtxDeps): ProxyCtx {
  const { init, errors } = deps;
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(message, err ?? ''));
  let stopped = false;
  let nextId = 1;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const subs = new Map<number, (...args: unknown[]) => unknown>();
  const exposes = new Map<number, Exposed>();
  const running = new Map<number, AbortController>();
  const scheduled = new Set<() => void>();
  let onActionId: number | null = null;

  /** Send, turning a serialization failure into a TypeError naming the member. */
  const post = (message: ChildMessage, path: string): void => {
    try {
      deps.send(message);
    } catch (err) {
      throw new TypeError(
        `ctx.${path} got something DorkOS can't receive (a function, symbol or class instance): ` +
          String((err as Error)?.message ?? err),
        { cause: err }
      );
    }
  };

  const request = (path: string, args: unknown[]): Promise<unknown> => {
    if (stopped)
      return Promise.reject(new Error(`ctx.${path} was called after the extension stopped.`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      try {
        post({ type: 'call', id, path, args }, path);
      } catch (err) {
        calls.delete(id);
        reject(err as Error);
      }
    });
  };

  const subscribe = (path: string, kind: SubscribeKind) => (listener: unknown) => {
    if (stopped) throw new Error(`ctx.${path} was called after the extension stopped.`);
    if (!isFunction(listener)) throw new TypeError(`${path} needs a listener function.`);
    // The host refuses this too; refusing here as well keeps the in-process
    // shape (a synchronous throw) for an extension without the grant.
    if (kind.gate === 'agents' && !init.allowAgents) {
      throw new errors.AgentSendError('not_allowed' as never, AGENTS_REFUSAL);
    }
    const id = nextId++;
    subs.set(id, listener);
    try {
      post({ type: 'sub', id, path }, path);
    } catch (err) {
      subs.delete(id);
      throw err;
    }
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (!subs.delete(id) || stopped) return;
      try {
        deps.send({ type: 'unsub', id });
      } catch {
        /* the host releases everything when the child stops anyway */
      }
    };
  };

  /** Expose a function under a fresh id; returns the unregister function. */
  const expose = (path: string, exposed: Exposed, methods?: string[]): (() => void) => {
    if (stopped) throw new Error(`ctx.${path} was called after the extension stopped.`);
    const id = nextId++;
    exposes.set(id, exposed);
    try {
      post({ type: 'expose', id, path, ...(methods ? { methods } : {}) }, path);
    } catch (err) {
      exposes.delete(id);
      throw err;
    }
    let removed = false;
    const unregister = () => {
      if (removed) return;
      removed = true;
      if (!exposes.delete(id) || stopped) return;
      try {
        deps.send({ type: 'unexpose', id });
      } catch {
        /* released on stop */
      }
    };
    (unregister as { exposeId?: number }).exposeId = id;
    return unregister;
  };

  const reverseBinders: Record<string, (kind: ReverseKind) => (...args: unknown[]) => unknown> = {
    'accounts.registerAdvisor': () => (advisor: unknown) => {
      const target = advisor as Record<string, unknown> | null | undefined;
      if (!target || !isFunction(target.rank)) {
        throw new TypeError('An account advisor needs a rank(candidates, ctx) function.');
      }
      // The methods present now are the ones the host's proxy advisor has.
      const methods = ADVISOR_METHODS.filter((m) => isFunction(target[m]));
      return expose(
        'accounts.registerAdvisor',
        {
          resolve: (method) =>
            (methods as readonly string[]).includes(method) && isFunction(target[method])
              ? (target[method] as (...args: unknown[]) => unknown).bind(target)
              : undefined,
        },
        [...methods]
      );
    },
    'inbox.onAction': () => (handler: unknown) => {
      if (!isFunction(handler)) throw new TypeError('inbox.onAction needs a handler function.');
      // A second handler replaces the first, as in-process: the host's real
      // onAction replaces it there, and the old one is forgotten here.
      if (onActionId !== null) exposes.delete(onActionId);
      const unregister = expose('inbox.onAction', {
        resolve: (method) => (method === 'onAction' ? handler : undefined),
      });
      onActionId = (unregister as { exposeId?: number }).exposeId ?? null;
      return unregister;
    },
  };

  const schedule = (intervalSeconds: number, fn: () => Promise<void>): (() => void) => {
    if (stopped) return () => undefined;
    const seconds = Number.isFinite(intervalSeconds) ? intervalSeconds : MIN_INTERVAL_SECONDS;
    const clamped = Math.max(seconds, MIN_INTERVAL_SECONDS);
    const interval = setInterval(() => {
      Promise.resolve()
        .then(() => fn())
        .catch((err: unknown) => log(`[ext:${init.extensionId}] Scheduled task error:`, err));
    }, clamped * 1000);
    const cancel = () => {
      clearInterval(interval);
      scheduled.delete(cancel);
    };
    scheduled.add(cancel);
    return cancel;
  };

  // Fail closed until the host's person verdict reaches the child (spec §7).
  const requirePerson: RequestHandler = (_req, res) => {
    res.status(403).json({
      error: `Only a person can change ${init.displayName}'s settings.`,
      code: 'extension_person_required',
    });
  };

  const consts: Record<string, string> = {
    extensionId: init.extensionId,
    extensionDir: init.ctx.extensionDir,
    dorkHome: init.ctx.dorkHome,
    filesDir: init.ctx.filesDir,
  };
  const locals: Record<string, unknown> = { schedule, requirePerson };

  const build = (members: { readonly [name: string]: Kind }, prefix: string): object => {
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(members)) {
      const kind = members[name]!;
      const path = prefix ? `${prefix}.${name}` : name;
      switch (kind.kind) {
        case 'object':
          out[name] = build(kind.members, path);
          break;
        case 'const':
          if (!(path in consts)) throw new Error(`No value for ctx.${path}.`);
          out[name] = consts[path];
          break;
        case 'call':
          out[name] = (...args: unknown[]) => request(path, args);
          break;
        case 'emit':
          out[name] = (event: string, data: unknown) => {
            if (stopped) return;
            post({ type: 'emit', event, data }, path);
          };
          break;
        case 'subscribe':
          out[name] = subscribe(path, kind);
          break;
        case 'reverse': {
          const bind = reverseBinders[path];
          if (!bind) throw new Error(`No reverse binding for ctx.${path}.`);
          out[name] = bind(kind);
          break;
        }
        case 'local':
          if (!(path in locals)) throw new Error(`No local implementation of ctx.${path}.`);
          out[name] = locals[path];
          break;
        case 'refused': {
          const reason = kind.reason;
          out[name] = () => {
            throw new Error(reason);
          };
          break;
        }
        default: {
          const never: never = kind;
          throw new Error(`Unknown ctx kind ${String(never)}`);
        }
      }
    }
    return out;
  };

  const ctx = build(CTX_PROTOCOL, '') as DataProviderContext;

  const answer = (id: number, ok: boolean, payload: unknown): void => {
    if (!running.delete(id)) return; // cancelled: the host no longer wants it
    try {
      deps.send(
        ok
          ? { type: 'rret', id, ok: true, value: payload }
          : { type: 'rret', id, ok: false, error: payload }
      );
    } catch (err) {
      try {
        deps.send({ type: 'rret', id, ok: false, error: toWire(err) });
      } catch {
        /* nothing more to do */
      }
    }
  };

  const receive = (message: HostMessage): boolean => {
    switch (message.type) {
      case 'ret': {
        const call = calls.get(message.id);
        if (call) {
          calls.delete(message.id);
          if (message.ok) call.resolve(message.value);
          else call.reject(rebuildError(message.error, errors));
          return true;
        }
        // A refused registration: forget it, and say why in the log.
        if (subs.delete(message.id) || exposes.delete(message.id)) {
          log(`[ext:${init.extensionId}] ${message.error?.message ?? 'A listener was refused.'}`);
        }
        return true;
      }
      case 'evt': {
        const listener = subs.get(message.id);
        if (!listener) return true;
        try {
          const result = listener(...(Array.isArray(message.args) ? message.args : []));
          if (result && typeof (result as Promise<unknown>).catch === 'function') {
            (result as Promise<unknown>).catch((err: unknown) =>
              log(`[ext:${init.extensionId}] A listener failed:`, err)
            );
          }
        } catch (err) {
          log(`[ext:${init.extensionId}] A listener failed:`, err);
        }
        return true;
      }
      case 'rcall': {
        const { id, handler, method } = message;
        const fn = exposes.get(handler)?.resolve(method);
        const controller = new AbortController();
        running.set(id, controller);
        if (!fn) {
          answer(id, false, { name: 'Error', message: 'That handler is gone.' });
          return true;
        }
        const args = Array.isArray(message.args) ? message.args : [];
        Promise.resolve()
          .then(() => fn(...args))
          .then(
            (value) => answer(id, true, value),
            (err: unknown) => answer(id, false, toWire(err))
          );
        return true;
      }
      case 'cancel': {
        const controller = running.get(message.id);
        if (controller) {
          running.delete(message.id);
          controller.abort();
        }
        return true;
      }
      default:
        return false;
    }
  };

  const cancelScheduled = (): void => {
    for (const cancel of [...scheduled]) {
      try {
        cancel();
      } catch {
        /* swallow cancellation errors, as in-process */
      }
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelScheduled();
    for (const [, call] of calls) call.reject(new Error('The extension stopped.'));
    calls.clear();
    for (const [, controller] of running) controller.abort();
    running.clear();
  };

  return { ctx, receive, cancelScheduled, stop };
}
