/**
 * How every member of the server `ctx` crosses into an isolated extension's
 * own process (DOR-2686, spec §5.1, design decision D5).
 *
 * The host builds the extension's REAL ctx with `createDataProviderContext`
 * and the child gets a proxy that forwards to it. This table is the one place
 * that decides, for each member, how:
 *
 * | Kind        | Meaning                                                              |
 * | ----------- | -------------------------------------------------------------------- |
 * | `const`     | a value copied into the child at start (`extensionId`, `filesDir`…) |
 * | `call`      | an async request the host answers through the real ctx              |
 * | `emit`      | fire-and-forget (`ctx.emit`)                                         |
 * | `subscribe` | a listener the host registers on the real ctx; events go to the child |
 * | `reverse`   | the host calls a function the child holds and awaits its answer     |
 * | `local`     | implemented in the child, never sent (`schedule`, `requirePerson`)  |
 * | `object`    | a namespace whose members each have their own kind                  |
 *
 * `gate: 'agents'` marks a member an isolated extension may use only when its
 * manifest says `allow.agents: true` (spec §5.4). The host enforces it.
 *
 * ## Exhaustive by construction
 *
 * The table `satisfies ProtocolFor<DataProviderContext>`, which maps every key
 * of the context (recursively) to a kind and refuses extra keys. Adding a
 * member to `DataProviderContext` without deciding how it crosses is a type
 * error in the server package; a unit test walks a real in-process ctx for
 * the run-time half of the same rule.
 *
 * ## Imported by both sides
 *
 * The host's dispatcher and the child's proxy both read it, so it is bundled
 * into the child: no server-only imports (no logger, no config). The two
 * reverse bounds are restated here as numbers, and a test pins each to the
 * constant the host actually enforces.
 *
 * @module services/extensions/isolation/ctx-protocol
 */
import type { DataProviderContext } from '@dorkos/extension-api/server';

/** A value copied into the child at start. */
export interface ConstKind {
  readonly kind: 'const';
}

/** An async request the host answers through the real ctx. */
export interface CallKind {
  readonly kind: 'call';
  /** When set, an isolated extension needs this grant (`allow.agents`). */
  readonly gate?: 'agents';
}

/** A fire-and-forget message. */
export interface EmitKind {
  readonly kind: 'emit';
}

/** A listener registration whose events the host pushes to the child. */
export interface SubscribeKind {
  readonly kind: 'subscribe';
  /** When set, an isolated extension needs this grant (`allow.agents`). */
  readonly gate?: 'agents';
}

/** A function the child holds, which the host calls and awaits. */
export interface ReverseKind {
  readonly kind: 'reverse';
  /** The host's own bound on one call, in milliseconds. */
  readonly boundMs: number;
}

/** Implemented in the child; never crosses. */
export interface LocalKind {
  readonly kind: 'local';
}

/** A namespace whose members each have their own kind. */
export interface ObjectKind {
  readonly kind: 'object';
  readonly members: { readonly [name: string]: Kind };
}

/** How one ctx member crosses the boundary. */
export type Kind =
  ConstKind | CallKind | EmitKind | SubscribeKind | ReverseKind | LocalKind | ObjectKind;

/** The kinds a function-valued member may have. */
export type FunctionKind = CallKind | EmitKind | SubscribeKind | ReverseKind | LocalKind;

/** A leaf: any kind but a namespace. */
export type LeafKind = Exclude<Kind, ObjectKind>;

/**
 * The protocol a type needs: every key mapped to a kind, recursively, with
 * functions limited to the function kinds and plain values to `const`. An
 * object literal checked with `satisfies` also refuses keys `T` lacks.
 */
export type ProtocolFor<T> = {
  // NonNullable: an optional member (`x?: () => void`) is still a function,
  // and must not fall through to `const` because its type includes undefined.
  readonly [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? FunctionKind
    : NonNullable<T[K]> extends object
      ? { readonly kind: 'object'; readonly members: ProtocolFor<NonNullable<T[K]>> } | LocalKind
      : ConstKind;
};

/**
 * The account advisor's per-call bound (`ADVISOR_TIMEOUT_MS` in
 * `core/usage/account-advisor.ts`; a test pins the two together).
 */
export const ADVISOR_BOUND_MS = 2_000;

/**
 * The inbox action handler's per-call bound (`HANDLER_TIMEOUT_MS` in
 * `inbox/extension-inbox.ts`; a test pins the two together).
 */
export const INBOX_ACTION_BOUND_MS = 5_000;

/** The methods an advisor may have, in the order `AccountAdvisor` lists them. */
export const ADVISOR_METHODS = Object.freeze([
  'rank',
  'onLimited',
  'modelFallback',
  'carryOver',
  'claims',
  'move',
  'cancelAuto',
  'wait',
] as const);

/** One advisor method name. */
export type AdvisorMethodName = (typeof ADVISOR_METHODS)[number];

/**
 * A tool handler's bound on the reverse leg: none. Each tool's deadline
 * (`timeoutSeconds`) lives in the host's invoke wrapper
 * (`agent-tools/tool-binding.ts`), which aborts the call; the abort reaches
 * the child as a `cancel` (spec §8).
 */
export const TOOL_BOUND_MS = 0;

const konst = { kind: 'const' } as const;
const call = { kind: 'call' } as const;
const subscribe = { kind: 'subscribe' } as const;
const local = { kind: 'local' } as const;

/**
 * The protocol table: how every `DataProviderContext` member crosses.
 *
 * `tools.handle` is a `reverse` member with no bound of its own
 * ({@link TOOL_BOUND_MS}): the host binds a stub through the real
 * `ctx.tools.handle`, and the per-tool deadline, the gate, the result checks
 * and the stop order are the host wrapper's, exactly as in-process (spec §8).
 */
export const CTX_PROTOCOL = {
  secrets: {
    kind: 'object',
    members: { get: call, set: call, delete: call, has: call },
  },
  settings: {
    kind: 'object',
    members: { get: call, set: call, delete: call, getAll: call },
  },
  storage: { kind: 'object', members: { loadData: call, saveData: call } },
  schedule: local,
  emit: { kind: 'emit' },
  extensionId: konst,
  extensionDir: konst,
  dorkHome: konst,
  filesDir: konst,
  accounts: {
    kind: 'object',
    members: {
      list: call,
      usage: call,
      onUsage: subscribe,
      markContinued: call,
      registerAdvisor: { kind: 'reverse', boundMs: ADVISOR_BOUND_MS },
    },
  },
  projects: {
    kind: 'object',
    members: { resolve: call, list: call, report: call, onChange: subscribe },
  },
  inbox: {
    kind: 'object',
    members: {
      raise: call,
      resolve: call,
      record: call,
      list: call,
      onAction: { kind: 'reverse', boundMs: INBOX_ACTION_BOUND_MS },
    },
  },
  requirePerson: local,
  projectSettings: { kind: 'object', members: { get: call, onChange: subscribe } },
  sessions: { kind: 'object', members: { start: { kind: 'call', gate: 'agents' } } },
  agent: {
    kind: 'object',
    members: {
      send: { kind: 'call', gate: 'agents' },
      subscribe: { kind: 'subscribe', gate: 'agents' },
    },
  },
  tools: {
    kind: 'object',
    members: { handle: { kind: 'reverse', boundMs: TOOL_BOUND_MS } },
  },
} as const satisfies ProtocolFor<DataProviderContext>;

/** A path segment: a plain identifier, never a prototype key. */
const SEGMENT = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** Keys no lookup may ever resolve, whatever the table says. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The longest dotted path the table has (two segments) plus room for one level more. */
const MAX_SEGMENTS = 3;

/**
 * Split a dotted path into checked segments, or `null` when it is not one the
 * table could hold.
 *
 * @param path - A dotted path such as `inbox.raise`, as the child sent it.
 */
export function splitPath(path: unknown): string[] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return null;
  const segments = path.split('.');
  if (segments.length > MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment)) return null;
  }
  return segments;
}

/**
 * The kind of the member at a dotted path, or `undefined` when the table has
 * no such member. Only the table's own keys are read (never an inherited one),
 * so `constructor`, `__proto__` or `toString` resolve to nothing.
 *
 * @param path - A dotted path such as `accounts.onUsage`.
 */
export function lookup(path: unknown): Kind | undefined {
  const segments = splitPath(path);
  if (!segments) return undefined;
  let members: { readonly [name: string]: Kind } = CTX_PROTOCOL;
  let found: Kind | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (!Object.prototype.hasOwnProperty.call(members, segment)) return undefined;
    found = members[segment];
    if (!found) return undefined;
    if (i < segments.length - 1) {
      if (found.kind !== 'object') return undefined;
      members = found.members;
    }
  }
  return found;
}

/** One leaf of the table, with its full dotted path. */
export interface ProtocolLeaf {
  path: string;
  kind: LeafKind;
}

/**
 * Every leaf of the table, depth-first, in declaration order.
 *
 * @param members - A namespace (the whole table by default).
 * @param prefix - The path of that namespace.
 */
export function flatten(
  members: { readonly [name: string]: Kind } = CTX_PROTOCOL,
  prefix = ''
): ProtocolLeaf[] {
  const out: ProtocolLeaf[] = [];
  for (const name of Object.keys(members)) {
    const kind = members[name]!;
    const path = prefix ? `${prefix}.${name}` : name;
    if (kind.kind === 'object') out.push(...flatten(kind.members, path));
    else out.push({ path, kind });
  }
  return out;
}

/** Freeze the table, deeply, so nothing at run time can widen what it allows. */
function deepFreeze(value: object): void {
  for (const key of Object.keys(value)) {
    const inner = (value as Record<string, unknown>)[key];
    if (inner && typeof inner === 'object') deepFreeze(inner);
  }
  Object.freeze(value);
}
deepFreeze(CTX_PROTOCOL);
