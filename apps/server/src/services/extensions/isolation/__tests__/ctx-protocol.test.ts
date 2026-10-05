/**
 * The ctx protocol table (DOR-2686 task 4.1): every member of the server ctx
 * has exactly one decision about how it crosses into an isolated child, at
 * the type level (a member without an entry does not compile) and at run time
 * (a real in-process ctx has no member the table misses, and the table names
 * nothing the ctx lacks). Also the lookup's refusal of anything that is not a
 * table entry.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import { ADVISOR_TIMEOUT_MS } from '../../../core/usage/account-advisor.js';
import { HANDLER_TIMEOUT_MS } from '../../inbox/extension-inbox.js';
import {
  ADVISOR_BOUND_MS,
  CTX_PROTOCOL,
  INBOX_ACTION_BOUND_MS,
  flatten,
  lookup,
  splitPath,
  type ProtocolFor,
} from '../ctx-protocol.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Type-level exhaustiveness ------------------------------------------------
// Each fixture below must FAIL to compile; `@ts-expect-error` turns a fixture
// that compiles into a typecheck error, so these lines are tests too.

/** A context with two function members and one plain value. */
interface FixtureCtx {
  ping(): Promise<void>;
  extra(): void;
  readonly name: string;
  readonly nested: { get(): Promise<string>; added(): void };
}

const fixtureCall = { kind: 'call' } as const;

// Purpose: a function member with no entry is a build error (the core rule).
const missingMember = {
  ping: fixtureCall,
  name: { kind: 'const' },
  nested: { kind: 'object', members: { get: fixtureCall, added: fixtureCall } },
  // @ts-expect-error `extra` has no protocol entry (reported on the satisfies clause)
} as const satisfies ProtocolFor<FixtureCtx>;

// Purpose: a nested member with no entry is a build error too.
const missingNested = {
  ping: fixtureCall,
  extra: fixtureCall,
  name: { kind: 'const' },
  // @ts-expect-error `nested.added` has no protocol entry
  nested: { kind: 'object', members: { get: fixtureCall } },
} as const satisfies ProtocolFor<FixtureCtx>;

// Purpose: a function cannot be declared a `const` (it would be copied, not called).
const functionAsConst = {
  ping: fixtureCall,
  // @ts-expect-error a function member cannot be `const`
  extra: { kind: 'const' },
  name: { kind: 'const' },
  nested: { kind: 'object', members: { get: fixtureCall, added: fixtureCall } },
} as const satisfies ProtocolFor<FixtureCtx>;

// Purpose: an entry for a member the context does not have is refused, so the
// table cannot drift ahead of the interface either.
const extraEntry = {
  ping: fixtureCall,
  extra: fixtureCall,
  name: { kind: 'const' },
  nested: { kind: 'object', members: { get: fixtureCall, added: fixtureCall } },
  // @ts-expect-error `ghost` is not a member of the context
  ghost: fixtureCall,
} as const satisfies ProtocolFor<FixtureCtx>;

// Purpose: an entry for a nested member the context does not have is refused too.
const extraNestedEntry = {
  ping: fixtureCall,
  extra: fixtureCall,
  name: { kind: 'const' },
  nested: {
    kind: 'object',
    // @ts-expect-error `nested.ghost` is not a member of the context
    members: { get: fixtureCall, added: fixtureCall, ghost: fixtureCall },
  },
} as const satisfies ProtocolFor<FixtureCtx>;

/** A context with an optional function member. */
interface OptionalCtx {
  maybe?: () => Promise<void>;
}

// Purpose: an optional function member is still a function: `const` (which
// would copy `undefined` into the child) is refused, a function kind accepted.
const optionalAsConst = {
  // @ts-expect-error an optional function member cannot be `const`
  maybe: { kind: 'const' },
} as const satisfies ProtocolFor<OptionalCtx>;
const optionalAsCall = { maybe: fixtureCall } as const satisfies ProtocolFor<OptionalCtx>;

void [
  missingMember,
  missingNested,
  functionAsConst,
  extraEntry,
  extraNestedEntry,
  optionalAsConst,
  optionalAsCall,
];

// --- Run time -----------------------------------------------------------------

/** Is this a plain object literal (as opposed to a class instance)? */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Every member path of a real ctx: own enumerable keys of the ctx and of each
 * plain-object namespace. A class instance (the secret and settings stores)
 * is reported as `classInstance` instead: its public methods live on its
 * prototype beside TS-private helpers no table should list, and the lookup
 * test below proves those helpers are unreachable.
 */
function walk(ctx: object): {
  functions: string[];
  values: string[];
  classInstances: string[];
} {
  const functions: string[] = [];
  const values: string[] = [];
  const classInstances: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (typeof value === 'function') functions.push(key);
    else if (value && typeof value === 'object') {
      if (!isPlainObject(value)) {
        classInstances.push(key);
        continue;
      }
      for (const [inner, member] of Object.entries(value)) {
        if (typeof member === 'function') functions.push(`${key}.${inner}`);
        else values.push(`${key}.${inner}`);
      }
    } else values.push(key);
  }
  return { functions, values, classInstances };
}

/** Read a dotted path off a ctx, own properties first, then prototype methods. */
function at(ctx: object, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], ctx);
}

describe('CTX_PROTOCOL against a real in-process ctx', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-protocol-'));
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  function build() {
    return createDataProviderContext({
      extensionId: 'proto-ext',
      extensionDir: path.join(dorkHome, 'ext'),
      dorkHome,
    });
  }

  // Purpose: the run-time half of exhaustiveness. Every function-valued member
  // of a real ctx has a leaf entry, and no leaf is a `const` for a function.
  it('has an entry for every function member of a real ctx', () => {
    const { ctx, releaseListeners } = build();
    const { functions } = walk(ctx);
    expect(functions.length).toBeGreaterThan(20);
    for (const p of functions) {
      const kind = lookup(p);
      expect(kind, `${p} has no protocol entry`).toBeDefined();
      expect(['const', 'object'], `${p} is a function`).not.toContain(kind!.kind);
    }
    releaseListeners();
  });

  // Purpose: plain values (ids and folders) are `const`, copied at start.
  it('marks every plain value of a real ctx as const', () => {
    const { ctx, releaseListeners } = build();
    for (const p of walk(ctx).values) expect(lookup(p)?.kind, p).toBe('const');
    releaseListeners();
  });

  // Purpose: the other direction. Every leaf the table names exists on a real
  // ctx with the right shape, so the table cannot promise a member nobody has.
  it('names nothing a real ctx lacks', () => {
    const { ctx, releaseListeners } = build();
    for (const { path: p, kind } of flatten()) {
      const value = at(ctx, p);
      if (kind.kind === 'const') expect(typeof value, p).toBe('string');
      else expect(typeof value, p).toBe('function');
    }
    // Class-instance namespaces are covered here: each listed member is a
    // method of the instance (checked above), and the table lists them all.
    const { classInstances } = walk(ctx);
    expect(classInstances.sort()).toEqual(['secrets', 'settings']);
    releaseListeners();
  });

  // Purpose: every top-level key of a real ctx is in the table, and vice versa.
  it('covers the same top-level members as a real ctx', () => {
    const { ctx, releaseListeners } = build();
    expect(Object.keys(CTX_PROTOCOL).sort()).toEqual(Object.keys(ctx).sort());
    releaseListeners();
  });
});

describe('lookup', () => {
  // Purpose: real entries resolve to their kind.
  it('resolves table entries', () => {
    expect(lookup('inbox.raise')).toEqual({ kind: 'call' });
    expect(lookup('agent.send')).toEqual({ kind: 'call', gate: 'agents' });
    expect(lookup('agent.subscribe')).toEqual({ kind: 'subscribe', gate: 'agents' });
    expect(lookup('accounts.registerAdvisor')).toEqual({ kind: 'reverse', boundMs: 2_000 });
    expect(lookup('emit')).toEqual({ kind: 'emit' });
    expect(lookup('tools.handle')).toEqual({ kind: 'reverse', boundMs: 0 });
  });

  // Purpose: nothing outside the table's own keys resolves: prototype keys,
  // inherited methods, host-only methods of the real stores (`secrets.keys`
  // is public on the class but not on the interface), injected separators.
  it.each([
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'secrets.__proto__',
    'secrets.constructor',
    'secrets.keys',
    'secrets.mutate',
    'secrets.get.call',
    'inbox.raise.apply',
    'inbox..raise',
    '.inbox',
    'inbox.',
    'inbox raise',
    'inbox["raise"]',
    'inbox/raise',
    'agent.send\u0000',
    'a.b.c.d',
    'x'.repeat(300),
    '',
  ])('refuses %j', (p) => {
    expect(lookup(p)).toBeUndefined();
  });

  // Purpose: non-strings never resolve (a child can send any type).
  it.each([undefined, null, 1, {}, ['inbox', 'raise'], { toString: () => 'inbox.raise' }])(
    'refuses a non-string path %#',
    (p) => {
      expect(lookup(p)).toBeUndefined();
      expect(splitPath(p)).toBeNull();
    }
  );

  // Purpose: the table cannot be widened at run time by code that reaches it
  // (it is bundled into the child, where extension code runs beside it).
  it('is frozen deeply', () => {
    expect(Object.isFrozen(CTX_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(CTX_PROTOCOL.inbox.members)).toBe(true);
    expect(() => {
      (CTX_PROTOCOL.inbox.members as Record<string, unknown>).evil = { kind: 'call' };
    }).toThrow();
  });
});

describe('reverse bounds', () => {
  // Purpose: the bounds restated in the child-safe table are the ones the
  // host actually enforces.
  it('match the host constants', () => {
    expect(ADVISOR_BOUND_MS).toBe(ADVISOR_TIMEOUT_MS);
    expect(INBOX_ACTION_BOUND_MS).toBe(HANDLER_TIMEOUT_MS);
  });
});

describe('flatten', () => {
  // Purpose: every leaf is listed once with a full path.
  it('lists each leaf once', () => {
    const paths = flatten().map((leaf) => leaf.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('projectSettings.onChange');
    expect(paths).toContain('extensionId');
    expect(paths).not.toContain('inbox');
  });
});
