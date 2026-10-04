/**
 * The host half of `ctx` over the boundary (DOR-2686, spec §5, design
 * decision D5): every ctx message from an isolated child runs through the
 * extension's REAL ctx, built by `createDataProviderContext` exactly as for an
 * in-process extension, so its validation, scoping, listener tracking,
 * `release` and `dispose` apply unchanged.
 *
 * ## The child is untrusted
 *
 * - **Only the table.** A message names a member by dotted path; the path is
 *   resolved through {@link lookup}, which reads only the protocol table's own
 *   keys and refuses prototype keys, so a child can reach a member only when
 *   the table lists it with the kind the message claims (`call` for `call`,
 *   `subscribe` for `sub`, `reverse` for `expose`). `secrets.keys` exists on
 *   the real store but not in the table, so it is unreachable.
 * - **Identity comes from the host.** The ctx this dispatcher holds was built
 *   for one extension id. No message carries an id the host acts on: the
 *   numbers in `call`, `sub` and `expose` only pair answers with questions.
 * - **Grants are checked here.** A member gated on `allow.agents` (spec §5.4)
 *   is refused unless the manifest's isolation view says so, whatever the
 *   child thinks.
 * - **Plain data only.** Arguments, emitted data, and the answers of reverse
 *   calls must pass {@link wireDataProblem}; size was bounded before the
 *   message got here (`isolated-host.ts`), and at most 256 calls wait at once.
 * - **Errors carry no host detail.** An error sent to the child is its name,
 *   a path-redacted message, its `code`, and its own primitive fields, never a
 *   stack.
 * - **Nothing outlives the child.** {@link CtxDispatcher.close} (called when
 *   the child's process ends, for any reason) removes every listener and
 *   reverse handler it registered on the real ctx and rejects every reverse
 *   call still waiting; after it, nothing is sent.
 *
 * @module services/extensions/isolation/ctx-dispatcher
 */
import {
  AgentSendError,
  type AccountAdvisor,
  type DataProviderContext,
  type DecisionActionEvent,
} from '@dorkos/extension-api/server';
import { redactPaths } from '../agent-tools/tool-binding.js';
import {
  ADVISOR_METHODS,
  lookup,
  splitPath,
  type AdvisorMethodName,
  type Kind,
} from './ctx-protocol.js';
import { wireDataProblem } from './ctx-wire.js';
import type {
  CallMessage,
  CtxChildMessage,
  EmitMessage,
  ExposeMessage,
  HostMessage,
  RretMessage,
  SubMessage,
  WireError,
} from './ipc-protocol.js';

/** What the host tells an isolated extension that has no `allow.agents`. */
export const AGENTS_REFUSAL = "This extension didn't ask to message your agents.";

/** Most listeners plus reverse handlers one child may hold on the real ctx at once. */
export const MAX_CHILD_REGISTRATIONS = 64;

/** Most arguments a ctx call may carry (the widest ctx method takes two). */
const MAX_CALL_ARGS = 8;

/** Longest event name `ctx.emit` accepts from a child. */
const MAX_EVENT_NAME = 200;

/** Longest error message sent to a child. */
const MAX_ERROR_MESSAGE = 1_000;

/** Most own fields of an error sent to a child. */
const MAX_ERROR_PROPS = 16;

/** Slack added to a reverse call's bound, so the real wrapper's own bound answers first. */
const REVERSE_SLACK_MS = 250;

/** Fields of an error never copied to the child (host detail, or carried separately). */
const DROPPED_ERROR_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'message',
  'code',
  'stack',
  'cause',
  'path',
  'dest',
  'syscall',
  'errno',
  'address',
  'port',
]);

/** A field or error name: a plain identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The log the dispatcher writes to. */
export interface DispatcherLogger {
  warn(message: string): void;
}

/** What {@link CtxDispatcher} needs. */
export interface CtxDispatcherOptions {
  /** The extension id (for the log only; the ctx carries the real identity). */
  extensionId: string;
  /** Its display name, for messages. */
  displayName: string;
  /** The extension's REAL ctx, from `createDataProviderContext`. */
  ctx: DataProviderContext;
  /** Whether its manifest says `allow.agents: true`. */
  allowAgents: boolean;
  /** Send one message to the child. */
  send: (message: HostMessage) => boolean;
  /** The host's limit on calls waiting at once (shared with the program broker). */
  slots: { acquire(): boolean; release(): void };
  /** The log. */
  logger: DispatcherLogger;
}

/** One reverse call the host is waiting on. */
interface PendingRcall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Make the error a child sees for a refusal the dispatcher itself decides. */
function refusal(message: string, code?: string): WireError {
  return { name: 'Error', message, ...(code ? { code } : {}) };
}

/**
 * Turn anything the real ctx threw into a {@link WireError}: no stack, file
 * paths redacted from every string, only primitive own fields.
 *
 * @param err - What was thrown.
 */
export function toWireError(err: unknown): WireError {
  const source = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const rawName = source.name;
  const name = typeof rawName === 'string' && IDENTIFIER.test(rawName) ? rawName : 'Error';
  let message: string;
  try {
    message = err instanceof Error ? String(err.message) : typeof err === 'string' ? err : '';
  } catch {
    message = '';
  }
  message = redactPaths(message).slice(0, MAX_ERROR_MESSAGE) || 'Something went wrong.';
  const out: WireError = { name, message };
  const code = source.code;
  if (typeof code === 'string' && code.length <= 64) out.code = code;
  const props: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const key of Object.keys(source)) {
    if (count >= MAX_ERROR_PROPS) break;
    if (DROPPED_ERROR_FIELDS.has(key) || !IDENTIFIER.test(key)) continue;
    let value: unknown;
    try {
      value = source[key];
    } catch {
      continue;
    }
    if (typeof value === 'string') props[key] = redactPaths(value).slice(0, MAX_ERROR_MESSAGE);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      props[key] = value;
    } else continue;
    count++;
  }
  if (count > 0) out.props = props;
  return out;
}

/** Rebuild an error a child sent in an `rret`, as a plain host `Error`. */
function fromChildError(error: unknown, displayName: string): Error {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message.slice(0, MAX_ERROR_MESSAGE)
      : `${displayName} failed without saying why.`;
  const err = new Error(message);
  if (typeof record.code === 'string' && record.code.length <= 64) {
    Object.defineProperty(err, 'code', { value: record.code, enumerable: true });
  }
  return err;
}

/** The refusal for a gated member, by namespace (spec §5.4). */
function gateRefusal(path: string): Error {
  return path.startsWith('agent.')
    ? new AgentSendError('not_allowed', AGENTS_REFUSAL)
    : new Error(AGENTS_REFUSAL);
}

/**
 * Binds a child's exposed function onto the real ctx. Each returns the
 * unregister function the real ctx hands back.
 */
type ReverseBinder = (
  dispatcher: CtxDispatcher,
  ctx: DataProviderContext,
  exposeId: number,
  boundMs: number,
  methods: unknown
) => (() => void) | WireError;

/**
 * How each `reverse` table entry is bound. A test asserts every `reverse`
 * leaf of the table has a binder here, so a reverse member cannot be added to
 * the table without deciding how the host carries it.
 */
export const REVERSE_BINDERS: Readonly<Record<string, ReverseBinder>> = Object.freeze({
  'accounts.registerAdvisor': (dispatcher, ctx, exposeId, boundMs, methods) => {
    if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      methods.length > ADVISOR_METHODS.length ||
      !methods.every(
        (m): m is AdvisorMethodName =>
          typeof m === 'string' && (ADVISOR_METHODS as readonly string[]).includes(m)
      ) ||
      new Set(methods).size !== methods.length ||
      !methods.includes('rank')
    ) {
      return refusal('An account advisor needs a rank method, and only advisor methods.');
    }
    // Exactly the methods the child's advisor has: core treats a missing
    // method as "use the default", so a proxy must not invent one.
    const advisor: Partial<Record<AdvisorMethodName, (...args: unknown[]) => Promise<unknown>>> =
      Object.create(null);
    for (const method of methods) {
      advisor[method] = (...args: unknown[]) => dispatcher.rcall(exposeId, method, args, boundMs);
    }
    return ctx.accounts.registerAdvisor(advisor as unknown as AccountAdvisor);
  },
  'inbox.onAction': (dispatcher, ctx, exposeId, boundMs) =>
    ctx.inbox.onAction(
      (event: DecisionActionEvent) =>
        dispatcher.rcall(exposeId, 'onAction', [event], boundMs) as ReturnType<
          Parameters<DataProviderContext['inbox']['onAction']>[0]
        >
    ),
});

/**
 * Dispatches one isolated child's ctx messages into its real ctx. One per
 * child process: a restart gets a fresh dispatcher.
 */
export class CtxDispatcher {
  private closed = false;
  private readonly subs = new Map<number, () => void>();
  private readonly exposes = new Map<number, () => void>();
  /** Which reverse member each expose id is bound to. */
  private readonly exposePaths = new Map<number, string>();
  private readonly rcalls = new Map<number, PendingRcall>();
  private nextRcallId = 1;
  private readonly counts = new Map<string, number>();

  /**
   * Build a dispatcher; it does nothing until messages arrive.
   *
   * @param options - See {@link CtxDispatcherOptions}.
   */
  constructor(private readonly options: CtxDispatcherOptions) {}

  /**
   * How many times each member was reached through the real ctx (a call made,
   * a listener or handler registered, an event emitted). Diagnostics, and the
   * conformance suite's proof that the isolated leg really went through here.
   */
  dispatchCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** How many listeners and reverse handlers the child holds on the real ctx right now. */
  get registrations(): number {
    return this.subs.size + this.exposes.size;
  }

  /**
   * Handle one ctx message from the child. Its shape was checked
   * (`isChildMessage`) and its size bounded; nothing else was.
   *
   * @param message - The message.
   */
  handle(message: CtxChildMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'call':
        this.onCall(message);
        break;
      case 'emit':
        this.onEmit(message);
        break;
      case 'sub':
        this.onSub(message);
        break;
      case 'unsub':
        this.release(this.subs, message.id);
        break;
      case 'expose':
        this.onExpose(message);
        break;
      case 'unexpose':
        this.release(this.exposes, message.id);
        break;
      case 'rret':
        this.onRret(message);
        break;
    }
  }

  /**
   * The child is gone (or going): remove everything it registered on the real
   * ctx, reject every reverse call waiting on it, and send nothing more.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const map of [this.subs, this.exposes]) {
      for (const unregister of map.values()) {
        try {
          unregister();
        } catch (err) {
          this.warn(`removing a listener failed: ${String(err)}`);
        }
      }
      map.clear();
    }
    this.exposePaths.clear();
    for (const [, pending] of this.rcalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.options.displayName} stopped.`));
    }
    this.rcalls.clear();
  }

  /**
   * Call a function the child exposed and wait for its answer, bounded at
   * `boundMs` (plus a little slack so the real wrapper's own bound, such as
   * the advisor's, answers first). On timeout the child is told to cancel.
   *
   * @param exposeId - The `expose` id.
   * @param method - The function's name.
   * @param args - Its arguments.
   * @param boundMs - The member's bound from the table.
   */
  rcall(exposeId: number, method: string, args: unknown[], boundMs: number): Promise<unknown> {
    const name = this.options.displayName;
    if (this.closed) return Promise.reject(new Error(`${name} stopped.`));
    if (!this.exposes.has(exposeId)) {
      return Promise.reject(new Error(`${name} removed that handler.`));
    }
    const problem = wireDataProblem(args);
    if (problem)
      return Promise.reject(new Error(`DorkOS couldn't send that to ${name}: ${problem}.`));
    const id = this.nextRcallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.rcalls.delete(id)) return;
        this.options.send({ type: 'cancel', id });
        reject(new Error(`${name} didn't answer in time.`));
      }, boundMs + REVERSE_SLACK_MS);
      timer.unref?.();
      this.rcalls.set(id, { resolve, reject, timer });
      this.options.send({ type: 'rcall', id, handler: exposeId, method, args });
    });
  }

  /** Count one dispatch of a member. */
  private count(path: string): void {
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
  }

  /** Log one line about this extension. */
  private warn(text: string): void {
    this.options.logger.warn(`[Extensions] ${this.options.extensionId}: ${text}`);
  }

  /** Answer a request (or refuse a registration) with an error. */
  private refuse(id: number, error: WireError, logText?: string): void {
    if (logText) this.warn(logText);
    if (this.closed) return;
    this.options.send({ type: 'ret', id, ok: false, error });
  }

  /**
   * Resolve a table path to the real ctx's function and the object it is
   * called on. Only reached after {@link lookup} accepted the path, so every
   * segment is a member the table names.
   */
  private resolveReal(path: string): { fn: (...args: unknown[]) => unknown; self: unknown } | null {
    const segments = splitPath(path);
    if (!segments) return null;
    let self: unknown = undefined;
    let value: unknown = this.options.ctx;
    for (const segment of segments) {
      if (typeof value !== 'object' || value === null) return null;
      self = value;
      value = (value as Record<string, unknown>)[segment];
    }
    return typeof value === 'function'
      ? { fn: value as (...args: unknown[]) => unknown, self }
      : null;
  }

  /** Look a path up and require one kind; refuse (and log) otherwise. */
  private expect<K extends Kind['kind']>(
    id: number,
    path: string,
    kind: K
  ): Extract<Kind, { kind: K }> | null {
    const found = lookup(path);
    if (!found || found.kind !== kind) {
      if (found?.kind === 'refused') {
        this.refuse(id, refusal(found.reason, 'ERR_EXTENSION_CTX_REFUSED'));
      } else {
        // The path is not echoed back: it is whatever the child sent.
        this.refuse(
          id,
          refusal(
            "That isn't something an isolated extension's ctx can do.",
            'ERR_EXTENSION_CTX_UNKNOWN'
          ),
          `refused a ${kind} for an unknown ctx member`
        );
      }
      return null;
    }
    return found as Extract<Kind, { kind: K }>;
  }

  /** Whether a gated member may be used; refuses when not. */
  private gateOpen(id: number, path: string, gate: 'agents' | undefined): boolean {
    if (gate === 'agents' && !this.options.allowAgents) {
      this.refuse(id, toWireError(gateRefusal(path)));
      return false;
    }
    return true;
  }

  /** A `call`: run the real method, answer with its result or its error. */
  private onCall(message: CallMessage): void {
    const { id, path, args } = message;
    const kind = this.expect(id, path, 'call');
    if (!kind) return;
    if (!Array.isArray(args) || args.length > MAX_CALL_ARGS) {
      this.refuse(
        id,
        refusal('A ctx call takes a short list of arguments.'),
        'refused a malformed call'
      );
      return;
    }
    const problem = wireDataProblem(args);
    if (problem) {
      this.refuse(
        id,
        refusal(`ctx.${path} can't take that: ${problem}.`),
        `refused a call: ${problem}`
      );
      return;
    }
    if (!this.gateOpen(id, path, kind.gate)) return;
    const real = this.resolveReal(path);
    if (!real) {
      this.refuse(id, refusal(`ctx.${path} isn't available on this DorkOS.`));
      return;
    }
    if (!this.options.slots.acquire()) {
      this.refuse(id, refusal('Too many calls at once.', 'ERR_EXTENSION_TOO_MANY_CALLS'));
      return;
    }
    this.count(path);
    void Promise.resolve()
      .then(() => Reflect.apply(real.fn, real.self, args))
      .then(
        (value) => {
          if (this.closed) return;
          // The host's own answer: no size budgets (an extension may keep more
          // than 4 MB in storage, as in-process), but the same shape rules.
          const bad =
            value === undefined
              ? null
              : wireDataProblem(value, {
                  maxBytes: Number.POSITIVE_INFINITY,
                  maxNodes: Number.POSITIVE_INFINITY,
                });
          if (bad) {
            this.refuse(
              id,
              refusal(`ctx.${path} answered with something that can't be sent.`),
              `couldn't send ctx.${path}'s answer: ${bad}`
            );
            return;
          }
          this.options.send({ type: 'ret', id, ok: true, value });
        },
        (err: unknown) => this.refuse(id, toWireError(err))
      )
      .finally(() => this.options.slots.release());
  }

  /** An `emit`: the real `ctx.emit`, which namespaces the event by the real id. */
  private onEmit(message: EmitMessage): void {
    const { event, data } = message;
    if (event.length === 0 || event.length > MAX_EVENT_NAME || /[\p{Cc}]/u.test(event)) {
      this.warn('dropped an event with a bad name');
      return;
    }
    const problem = wireDataProblem(data);
    if (problem) {
      this.warn(`dropped an event: ${problem}`);
      return;
    }
    this.count('emit');
    try {
      this.options.ctx.emit(event, data);
    } catch (err) {
      this.warn(`emit failed: ${String(err)}`);
    }
  }

  /** Room for one more registration under `id`, or a refusal. */
  private roomFor(id: number): boolean {
    if (this.subs.has(id) || this.exposes.has(id)) {
      this.refuse(id, refusal('That id is already in use.'), 'refused a reused registration id');
      return false;
    }
    if (this.registrations >= MAX_CHILD_REGISTRATIONS) {
      this.refuse(id, refusal('Too many listeners at once.'), 'refused a listener over the limit');
      return false;
    }
    return true;
  }

  /** A `sub`: register a listener on the real ctx that forwards to the child. */
  private onSub(message: SubMessage): void {
    const { id, path } = message;
    const kind = this.expect(id, path, 'subscribe');
    if (!kind || !this.roomFor(id) || !this.gateOpen(id, path, kind.gate)) return;
    const real = this.resolveReal(path);
    if (!real) {
      this.refuse(id, refusal(`ctx.${path} isn't available on this DorkOS.`));
      return;
    }
    const listener = (...args: unknown[]): void => {
      // A listener the child removed, or a child that is gone, hears nothing.
      if (this.closed || !this.subs.has(id)) return;
      const problem = wireDataProblem(args);
      if (problem) {
        this.warn(`didn't forward a ctx.${path} event: ${problem}`);
        return;
      }
      this.options.send({ type: 'evt', id, args });
    };
    let unregister: unknown;
    try {
      unregister = Reflect.apply(real.fn, real.self, [listener]);
    } catch (err) {
      this.refuse(id, toWireError(err));
      return;
    }
    this.count(path);
    this.subs.set(id, typeof unregister === 'function' ? (unregister as () => void) : () => {});
  }

  /** An `expose`: bind a child-held function onto the real ctx. */
  private onExpose(message: ExposeMessage): void {
    const { id, path, methods } = message;
    const kind = this.expect(id, path, 'reverse');
    if (!kind || !this.roomFor(id)) return;
    const binder = Object.prototype.hasOwnProperty.call(REVERSE_BINDERS, path)
      ? REVERSE_BINDERS[path]
      : undefined;
    if (!binder) {
      this.refuse(id, refusal(`ctx.${path} isn't available to isolated extensions yet.`));
      return;
    }
    // Registered before binding: a real ctx that calls the handler at once
    // must find it.
    this.exposes.set(id, () => {});
    let result: (() => void) | WireError;
    try {
      result = binder(this, this.options.ctx, id, kind.boundMs, methods);
    } catch (err) {
      result = toWireError(err);
    }
    if (typeof result !== 'function') {
      this.exposes.delete(id);
      this.refuse(id, result);
      return;
    }
    this.count(path);
    this.exposes.set(id, result);
    this.exposePaths.set(id, path);
    // Both reverse members replace: a second advisor or action handler takes
    // the first one's place on the real ctx. Forget the replaced entries, so
    // re-registering cannot use up the child's registration limit. Their
    // unregister functions are safe to call now: each removes only its own
    // registration, which the new one already replaced.
    for (const [other, otherPath] of this.exposePaths) {
      if (other !== id && otherPath === path) this.release(this.exposes, other);
    }
  }

  /** An `rret`: settle the reverse call it answers. Unknown or late ids are ignored. */
  private onRret(message: RretMessage): void {
    const pending = this.rcalls.get(message.id);
    if (!pending) return;
    this.rcalls.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(fromChildError(message.error, this.options.displayName));
      return;
    }
    const problem = message.value === undefined ? null : wireDataProblem(message.value);
    if (problem) {
      this.warn(`refused an answer: ${problem}`);
      pending.reject(
        new Error(`${this.options.displayName} answered with something DorkOS can't use.`)
      );
      return;
    }
    pending.resolve(message.value);
  }

  /** Remove one registration (an `unsub` or `unexpose`). */
  private release(map: Map<number, () => void>, id: number): void {
    const unregister = map.get(id);
    if (!unregister) return;
    map.delete(id);
    if (map === this.exposes) this.exposePaths.delete(id);
    try {
      unregister();
    } catch (err) {
      this.warn(`removing a listener failed: ${String(err)}`);
    }
  }
}
