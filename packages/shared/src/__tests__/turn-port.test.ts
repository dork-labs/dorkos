/**
 * The turn port's contract is plain data, and its run-record vocabulary says
 * what the spec says (`specs/turns-survive-restarts` §3.2, §4.3).
 *
 * Every exported schema is found by reading the module itself, never from a
 * list kept here, so a schema added later without a sample fails the
 * round-trip case rather than being skipped by it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as port from '../turn-port.js';
import {
  RUN_TRANSITIONS,
  RunFactSchema,
  RunStatusSchema,
  StartTurnInputSchema,
  TERMINAL_RUN_STATUSES,
  TURN_ORIGIN_KINDS,
  TurnStartRequestSchema,
  canTransition,
  runReference,
  wireOriginOf,
  type RunStatus,
  type TurnOrigin,
  type WireOrigin,
} from '../turn-port.js';
import { SESSION_RELAY_MAX_MESSAGE_LENGTH } from '../session-relay.js';

const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const RUN = '01KJXYKJYW4N8QGQ5W4GB6YM9K';
const EARLIER_RUN = '01KJXYKJYW4N8QGQ5W4GB6YM9M';

/** Every origin, with the word it travels as on the agent-computer wire. */
const ORIGINS: ReadonlyArray<readonly [TurnOrigin, WireOrigin]> = [
  [{ kind: 'interactive' }, 'chat'],
  [{ kind: 'session-relay' }, 'chat'],
  [{ kind: 'room', externalAuthor: false }, 'room'],
  [{ kind: 'room', externalAuthor: true }, 'room'],
  [{ kind: 'schedule' }, 'task'],
  [{ kind: 'relay-binding' }, 'chat'],
  [{ kind: 'agent-dm' }, 'chat'],
  [{ kind: 'outside-sender' }, 'chat'],
  [{ kind: 'connector-event' }, 'chat'],
  [{ kind: 'agent-launch' }, 'chat'],
  [{ kind: 'agent-launch', launchedBy: AGENT }, 'chat'],
  [{ kind: 'extension-start' }, 'chat'],
  [{ kind: 'extension-message' }, 'chat'],
  [{ kind: 'chat-message' }, 'chat'],
  [{ kind: 'account-handoff' }, 'chat'],
  [{ kind: 'account-resume' }, 'chat'],
  [{ kind: 'resume' }, 'chat'],
  [{ kind: 'heartbeat' }, 'beat'],
  [{ kind: 'test-harness' }, 'chat'],
];

/** A start with every optional field filled. */
const FULL_INPUT = {
  sessionId: SESSION,
  agentId: AGENT,
  cwd: '/tmp/project',
  content: 'Summarise the open pull requests.',
  origin: { kind: 'room', externalAuthor: false },
  originRef: 'dork:room:room-1',
  tier: 'owner',
  permissionCeiling: [
    {
      asks: 'when-risky',
      reach: 'workspace',
      auto: true,
      outsider: true,
      teammate: [{ roomId: 'room-1', authorId: 'author-1' }],
    },
    'runtime-default',
  ],
  systemPromptAppend: 'Follow the room conventions.',
  additionalDirectories: [{ path: '/tmp/shared', access: 'read' }],
  prepare: { kind: 'room-files', roomId: 'room-1', authorId: 'author-1' },
  settings: { model: 'test-model', effort: 'high' },
  seedContext: 'This chat was opened by the Demo app so it can send this agent messages.',
} as const;

/** The same start as the computer face receives it, a continuation. */
const FULL_REQUEST = {
  ...FULL_INPUT,
  runId: RUN,
  attempt: 2,
  continuesRunId: EARLIER_RUN,
  wireOrigin: 'room',
  accountRef: 'account-1',
  playbookId: 'playbook-1',
} as const;

/** The least a start can carry. */
const MINIMAL_INPUT = {
  sessionId: SESSION,
  agentId: AGENT,
  cwd: '/tmp/project',
  content: 'Hello',
  origin: { kind: 'interactive' },
  tier: 'owner',
} as const;

/** A sample for every enum: each of its values. */
function enumValues(schema: z.ZodType): unknown[] {
  return (schema as unknown as { options: unknown[] }).options;
}

/**
 * Samples for every exported schema, keyed by export name. The round-trip case
 * fails for any exported schema missing here.
 */
const SAMPLES: Record<string, readonly unknown[]> = {
  TurnOriginSchema: ORIGINS.map(([origin]) => origin),
  RunIdSchema: [RUN],
  TurnPreparationSchema: [FULL_INPUT.prepare],
  StartTurnInputSchema: [
    MINIMAL_INPUT,
    {
      ...FULL_INPUT,
      notAfter: 1_764_000_000_000,
      accountHint: 'account-1',
      askedByRef: 'dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J',
      sourceRef: 'extension-send:3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c',
    },
  ],
  RunStatusSchema: enumValues(port.RunStatusSchema),
  StartTurnResultSchema: [{ runId: RUN, status: 'queued', queuePosition: 1 }],
  TurnStartRequestSchema: [
    { ...MINIMAL_INPUT, runId: RUN, attempt: 1, wireOrigin: 'chat' },
    FULL_REQUEST,
  ],
  RefusalReasonSchema: enumValues(port.RefusalReasonSchema),
  TurnStartAnswerSchema: [{ accepted: true }, { refused: 'already_held' }],
  RunEndingSchema: enumValues(port.RunEndingSchema),
  AttemptReasonSchema: enumValues(port.AttemptReasonSchema),
  WaitReasonSchema: enumValues(port.WaitReasonSchema),
  RunFactSchema: [
    { kind: 'accepted', runId: RUN },
    { kind: 'accepted', runId: RUN, joinedRunId: EARLIER_RUN },
    {
      kind: 'started',
      runId: RUN,
      sessionId: SESSION,
      openedBy: 'caller',
      runtime: 'claude-code',
      runtimeTurnRef: 42,
      turnBindingId: 'binding-1',
    },
    {
      kind: 'started',
      runId: RUN,
      sessionId: SESSION,
      openedBy: 'runtime',
      agentId: AGENT,
      runtime: 'claude-code',
      runtimeTurnRef: 7,
    },
    { kind: 'delivered', runId: RUN },
    { kind: 'waiting_on_person', runId: RUN },
    { kind: 'resumed_from_person', runId: RUN },
    {
      kind: 'background_work',
      runId: RUN,
      work: [
        { kind: 'bash', label: 'pnpm dev' },
        { kind: 'agent', label: 'Review the diff' },
      ],
    },
    { kind: 'ended', runId: RUN, ending: 'completed' },
    {
      kind: 'ended',
      runId: RUN,
      ending: 'stopped',
      receipt: { outcome: 'acked', runtime: 'claude-code' },
      stoppedBy: 'dork:person:person-1',
    },
    {
      kind: 'ended',
      runId: RUN,
      ending: 'stopped',
      receipt: { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'claude-code' },
      interrupted: true,
    },
    {
      kind: 'ended',
      runId: RUN,
      ending: 'completed',
      stopRequest: { by: 'dork:person:person-1', outcome: 'unconfirmed' },
    },
    { kind: 'ended', runId: RUN, ending: 'refused', refusal: 'The model is not available.' },
  ],
};

/** Every Zod schema the module exports, by export name. */
const EXPORTED_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = Object.entries(
  port as Record<string, unknown>
).flatMap(([name, value]) => (value instanceof z.ZodType ? [[name, value] as const] : []));

describe('every exported schema is plain data', () => {
  it('finds the schemas the spec names', () => {
    expect(EXPORTED_SCHEMAS.map(([name]) => name).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(EXPORTED_SCHEMAS)('%s round-trips through JSON', (name, schema) => {
    const samples = SAMPLES[name] ?? [];
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      // Parsing changes nothing (no transform, no default), and a value that
      // went through JSON parses back to the same value.
      expect(schema.parse(sample)).toEqual(sample);
      expect(schema.parse(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
    }
  });

  it.each(EXPORTED_SCHEMAS)('%s can hold nothing but JSON values', (name, schema) => {
    const { visited, refused } = walkSchema(schema, name);
    expect(refused).toEqual([]);
    expect(visited.length).toBeGreaterThan(0);
  });

  it('walks into nested members, not just the top', () => {
    const { visited } = walkSchema(StartTurnInputSchema, 'input');
    expect(visited).toEqual(
      expect.arrayContaining([
        'input.content',
        'input.additionalDirectories[].path',
        'input.permissionCeiling|0|0.teammate[].roomId',
      ])
    );
  });

  it('the walker refuses functions, class instances and other non-JSON members', () => {
    const cases: ReadonlyArray<readonly [string, z.ZodType]> = [
      ['function', z.strictObject({ onSettled: z.function() })],
      ['instance', z.strictObject({ signal: z.instanceof(AbortController) })],
      ['date', z.strictObject({ at: z.date() })],
      ['map', z.strictObject({ held: z.map(z.string(), z.string()) })],
      ['any', z.strictObject({ value: z.any() })],
      ['transform', z.strictObject({ n: z.string().transform(Number) })],
      ['loose object', z.object({ a: z.string() })],
    ];
    for (const [label, schema] of cases) {
      expect(walkSchema(schema, label).refused, label).not.toEqual([]);
    }
  });

  it('a callback beside the data is refused, not dropped', () => {
    const withCallback = { ...MINIMAL_INPUT, onSettled: () => undefined };
    expect(StartTurnInputSchema.safeParse(withCallback).success).toBe(false);
    expect(
      TurnStartRequestSchema.safeParse({
        ...MINIMAL_INPUT,
        runId: RUN,
        attempt: 1,
        wireOrigin: 'chat',
        privateDispatchSignal: new AbortController().signal,
      }).success
    ).toBe(false);
  });
});

/**
 * Whether a type, all the way down, is made of JSON values only: strings,
 * numbers, booleans, null, arrays and objects of the same. A function anywhere
 * in it, or a class instance (whose methods are functions), makes it false.
 */
type PlainLeaf = string | number | boolean | null | undefined;
type IsPlain<T> = T extends PlainLeaf
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends readonly (infer E)[]
      ? IsPlain<E>
      : T extends object
        ? false extends { [K in keyof T]-?: IsPlain<T[K]> }[keyof T]
          ? false
          : true
        : false;
type AllPlain<T> = [IsPlain<T>] extends [true] ? true : false;
type Holds<T extends true> = T;
type Refuses<T extends false> = T;

/** What every exported schema parses to, read off the module (so a new export is checked too). */
type PortOutputs = {
  [K in keyof typeof port]: (typeof port)[K] extends z.ZodType ? z.output<(typeof port)[K]> : never;
}[keyof typeof port];

/**
 * Checked by `tsc` (this package's typecheck covers its tests): every schema's
 * output type and the origin union hold plain data, and the check itself can
 * fail on a function, a live handle and a class instance.
 */
export type PlainDataProof = [
  // An empty union would pass the next line vacuously, so first prove it is not.
  Holds<[PortOutputs] extends [never] ? false : true>,
  Holds<AllPlain<PortOutputs>>,
  Holds<AllPlain<TurnOrigin>>,
  Refuses<AllPlain<{ onSettled: () => void }>>,
  Refuses<AllPlain<{ signal: AbortSignal }>>,
  Refuses<AllPlain<{ at: Date }>>,
  Refuses<AllPlain<{ nested: { list: readonly (() => void)[] } }>>,
];

describe('the transition table', () => {
  /** The fifteen legal pairs: the spec's table (§4.3) and the architect's rows 14 and 15. */
  const SPEC: ReadonlyArray<readonly [RunStatus | null, RunStatus]> = [
    [null, 'queued'],
    [null, 'running'],
    ['queued', 'queued'],
    ['queued', 'starting'],
    ['queued', 'cancelled'],
    ['queued', 'superseded'],
    ['starting', 'started'],
    ['starting', 'queued'],
    ['starting', 'cancelled'],
    ['started', 'running'],
    ['started', 'ended'],
    ['running', 'ended'],
    ['ended', 'settled'],
    ['started', 'queued'],
    ['running', 'queued'],
  ];
  const STATUSES = RunStatusSchema.options;

  it('holds exactly the fifteen rows, numbered 1 to 15', () => {
    expect(SPEC).toHaveLength(15);
    expect(RUN_TRANSITIONS.map(({ from, to }) => [from, to])).toEqual(SPEC);
    expect(RUN_TRANSITIONS.map(({ row }) => row)).toEqual(SPEC.map((_, index) => index + 1));
    expect(canTransition('starting', 'superseded')).toBe(false);
  });

  it('answers every pair, legal or not', () => {
    const legal = new Set(SPEC.map(([from, to]) => `${from}->${to}`));
    const pairs = [null, ...STATUSES].flatMap((from) => STATUSES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(9 * 8);
    for (const [from, to] of pairs) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}->${to}`));
    }
  });

  it('gives every non-terminal status a way out, and none to a terminal one', () => {
    expect(STATUSES).toHaveLength(8);
    for (const status of STATUSES) {
      const exits = STATUSES.filter((to) => to !== status && canTransition(status, to));
      if (TERMINAL_RUN_STATUSES.includes(status)) expect(exits, status).toEqual([]);
      else expect(exits.length, status).toBeGreaterThan(0);
    }
  });
});

describe('origins', () => {
  it('names all seventeen kinds, and the samples cover each', () => {
    expect(TURN_ORIGIN_KINDS).toHaveLength(17);
    expect([...new Set(ORIGINS.map(([origin]) => origin.kind))].sort()).toEqual(
      [...TURN_ORIGIN_KINDS].sort()
    );
  });

  it.each(ORIGINS)('%o travels as %s', (origin, wire) => {
    expect(wireOriginOf(origin)).toBe(wire);
  });
});

describe('a start request', () => {
  const FIRST = { ...MINIMAL_INPUT, runId: RUN, attempt: 1, wireOrigin: 'chat' } as const;

  it('refuses a wire origin that is not its origin', () => {
    expect(TurnStartRequestSchema.safeParse({ ...FIRST, wireOrigin: 'room' }).success).toBe(false);
  });

  it('names the run it continues exactly when it is a later attempt', () => {
    expect(
      TurnStartRequestSchema.safeParse({ ...FIRST, continuesRunId: EARLIER_RUN }).success
    ).toBe(false);
    expect(TurnStartRequestSchema.safeParse({ ...FIRST, attempt: 2 }).success).toBe(false);
    expect(
      TurnStartRequestSchema.safeParse({ ...FIRST, attempt: 2, continuesRunId: EARLIER_RUN })
        .success
    ).toBe(true);
  });

  it('refuses words over the cap at start, naming the cap', () => {
    const tooLong = { ...MINIMAL_INPUT, content: 'x'.repeat(SESSION_RELAY_MAX_MESSAGE_LENGTH + 1) };
    const result = StartTurnInputSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(String(SESSION_RELAY_MAX_MESSAGE_LENGTH));
    expect(
      StartTurnInputSchema.safeParse({
        ...MINIMAL_INPUT,
        content: 'x'.repeat(SESSION_RELAY_MAX_MESSAGE_LENGTH),
      }).success
    ).toBe(true);
  });

  it('takes a chat with no Mesh agent, but never an agent id that is not one', () => {
    const { agentId: _agentId, ...noAgent } = MINIMAL_INPUT;
    expect(StartTurnInputSchema.safeParse(noAgent).success).toBe(true);
    expect(
      StartTurnInputSchema.safeParse({ ...MINIMAL_INPUT, agentId: 'not-a-ulid' }).success
    ).toBe(false);
  });

  it('takes only a dork: reference as originRef', () => {
    expect(StartTurnInputSchema.safeParse({ ...MINIMAL_INPUT, originRef: 'room-1' }).success).toBe(
      false
    );
    expect(
      StartTurnInputSchema.safeParse({ ...MINIMAL_INPUT, originRef: 'dork:nope:room-1' }).success
    ).toBe(false);
  });

  it('names who asked by a dork: reference, and where the words wait by <kind>:<id>', () => {
    // Purpose: fails if a caller could put a free-form asker or source on the record.
    const parse = (extra: Record<string, unknown>) =>
      StartTurnInputSchema.safeParse({ ...MINIMAL_INPUT, ...extra }).success;
    expect(parse({ askedByRef: 'dork:chat:3f1c2b7a' })).toBe(true);
    expect(parse({ askedByRef: 'the owner' })).toBe(false);
    expect(parse({ sourceRef: 'extension-send:row-1' })).toBe(true);
    expect(parse({ sourceRef: 'row-1' })).toBe(false);
    expect(parse({ sourceRef: 'Extension:row 1' })).toBe(false);
  });
});

describe('refusals', () => {
  it('are the closed list the spec names, each with its row (§3.1)', () => {
    expect(port.RefusalReasonSchema.options).toEqual([
      'already_held',
      'chat_busy',
      'agent_paused',
      'invalid_agent_path',
      'unknown_runtime',
      'room_session_moved',
      'desk_not_own',
      'account_not_allowed',
    ]);
  });
});

describe('facts', () => {
  it('are the seven the spec names', () => {
    const kinds = RunFactSchema.options.map((option) => option.shape.kind.value);
    expect(kinds).toEqual([
      'accepted',
      'started',
      'delivered',
      'waiting_on_person',
      'resumed_from_person',
      'background_work',
      'ended',
    ]);
  });

  describe('a stopped ending needs proof the turn ended (ADR 260823-021312)', () => {
    const stopped = { kind: 'ended', runId: RUN, ending: 'stopped' } as const;
    type Outcome = 'acked' | 'closed' | 'not-running' | 'unconfirmed' | 'failed';
    const receipt = (outcome: Outcome) => ({ outcome, runtime: 'claude-code' });

    it('accepts a receipt whose stop ended the turn', () => {
      for (const outcome of ['acked', 'closed'] as const) {
        expect(RunFactSchema.safeParse({ ...stopped, receipt: receipt(outcome) }).success).toBe(
          true
        );
      }
    });

    it('refuses not-running alone: the turn had already finished on its own', () => {
      expect(RunFactSchema.safeParse({ ...stopped, receipt: receipt('not-running') }).success).toBe(
        false
      );
    });

    it("accepts an unconfirmed receipt with the runtime's own interrupt", () => {
      expect(
        RunFactSchema.safeParse({ ...stopped, receipt: receipt('unconfirmed'), interrupted: true })
          .success
      ).toBe(true);
      expect(RunFactSchema.safeParse({ ...stopped, interrupted: true }).success).toBe(true);
    });

    it('refuses an unconfirmed receipt alone, or no proof at all', () => {
      expect(RunFactSchema.safeParse({ ...stopped, receipt: receipt('unconfirmed') }).success).toBe(
        false
      );
      expect(RunFactSchema.safeParse(stopped).success).toBe(false);
    });

    it('never makes stopped from a failed receipt', () => {
      expect(RunFactSchema.safeParse({ ...stopped, receipt: receipt('failed') }).success).toBe(
        false
      );
      expect(
        RunFactSchema.safeParse({ ...stopped, receipt: receipt('failed'), interrupted: true })
          .success
      ).toBe(false);
    });

    it('keeps an unconfirmed request on a turn that ended on its own', () => {
      const completed = {
        kind: 'ended',
        runId: RUN,
        ending: 'completed',
        stopRequest: { outcome: 'unconfirmed' },
      } as const;
      expect(RunFactSchema.parse(JSON.parse(JSON.stringify(completed)))).toEqual(completed);
      expect(
        RunFactSchema.safeParse({ ...completed, receipt: receipt('unconfirmed') }).success
      ).toBe(false);
      expect(RunFactSchema.safeParse({ ...completed, interrupted: true }).success).toBe(false);
    });
  });

  it('names who stopped it only on a stopped ending, as a dork: reference', () => {
    const stopped = {
      kind: 'ended',
      runId: RUN,
      ending: 'stopped',
      receipt: { outcome: 'acked', runtime: 'claude-code' },
    } as const;
    const withStopper = { ...stopped, stoppedBy: `dork:agent:${AGENT}` };
    expect(RunFactSchema.parse(JSON.parse(JSON.stringify(withStopper)))).toEqual(withStopper);
    expect(RunFactSchema.safeParse({ ...stopped, stoppedBy: 'person-1' }).success).toBe(false);
    expect(
      RunFactSchema.safeParse({
        kind: 'ended',
        runId: RUN,
        ending: 'completed',
        stoppedBy: `dork:agent:${AGENT}`,
      }).success
    ).toBe(false);
  });

  it('a joined run is never the run being started', () => {
    expect(
      RunFactSchema.safeParse({ kind: 'accepted', runId: RUN, joinedRunId: RUN }).success
    ).toBe(false);
  });

  it('a runtime-opened turn is accepted with or without its agent', () => {
    const opened = {
      kind: 'started',
      runId: RUN,
      sessionId: SESSION,
      openedBy: 'runtime',
      runtime: 'claude-code',
      runtimeTurnRef: 7,
    } as const;
    expect(RunFactSchema.safeParse(opened).success).toBe(true);
    expect(RunFactSchema.safeParse({ ...opened, agentId: AGENT }).success).toBe(true);
    expect(RunFactSchema.safeParse({ ...opened, agentId: 'not-a-ulid' }).success).toBe(false);
    expect(RunFactSchema.safeParse({ ...opened, openedBy: 'caller' }).success).toBe(true);
  });

  it("only a refused ending carries the runtime's words", () => {
    expect(
      RunFactSchema.safeParse({ kind: 'ended', runId: RUN, ending: 'failed', refusal: 'No.' })
        .success
    ).toBe(false);
  });
});

describe('runReference', () => {
  it('spells a run as dork:turn:<id>', () => {
    expect(runReference(RUN)).toBe(`dork:turn:${RUN}`);
  });
});

/**
 * Walk a schema's definition and list every member that could hold something
 * other than a JSON value, with its path. Objects must be strict, so an extra
 * key is refused rather than silently dropped.
 */
function walkSchema(root: z.ZodType, rootPath: string): { visited: string[]; refused: string[] } {
  const visited: string[] = [];
  const refused: string[] = [];
  const walk = (schema: z.ZodType, path: string): void => {
    visited.push(path);
    const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
    switch (def.type) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'null':
      case 'enum':
        return;
      case 'literal': {
        const values = def.values as unknown[];
        for (const value of values) {
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
            refused.push(`${path}: literal ${String(value)}`);
          }
        }
        return;
      }
      case 'optional':
      case 'nullable':
      case 'readonly':
        return walk(def.innerType as z.ZodType, path);
      case 'array':
        return walk(def.element as z.ZodType, `${path}[]`);
      case 'union':
        (def.options as z.ZodType[]).forEach((option, index) => walk(option, `${path}|${index}`));
        return;
      case 'object': {
        const catchall = def.catchall as z.ZodType | undefined;
        if (catchall?._zod.def.type !== 'never') refused.push(`${path}: not strict`);
        for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) {
          walk(value, `${path}.${key}`);
        }
        return;
      }
      default:
        refused.push(`${path}: ${def.type}`);
    }
  };
  walk(root, rootPath);
  return { visited, refused };
}
