import { describe, it, expect } from 'vitest';
import type { SessionActivity, SessionLifecycle } from '@dorkos/shared/session-stream';
import { SessionLifecycleSchema } from '@dorkos/shared/session-stream';
import { activityVerb, WAITING_ON_YOU_VERB } from '../activity-verb';

describe('activityVerb — the honesty ladder (BC-37)', () => {
  it('says the strongest thing first: a blocked turn is waiting on YOU', () => {
    expect(activityVerb('blocked')).toBe(WAITING_ON_YOU_VERB);
    // Even with a tool reading to hand — "waiting on you" is about the reader,
    // and that outranks anything about the agent.
    expect(activityVerb('blocked', { toolName: 'Bash', target: 'pnpm test' })).toBe(
      WAITING_ON_YOU_VERB
    );
  });

  it('names the tool and its target when the server knows both', () => {
    expect(activityVerb('streaming', { toolName: 'Edit', target: 'RoomRow.tsx' })).toBe(
      'Editing RoomRow.tsx…'
    );
  });

  it('drops to the bare verb when the target is unknown', () => {
    expect(activityVerb('streaming', { toolName: 'Bash' })).toBe('Running a command…');
  });

  it('names the MCP server rather than its method, which nobody outside it reads', () => {
    expect(activityVerb('streaming', { toolName: 'mcp__slack__send_message' })).toBe(
      'Using Slack…'
    );
  });

  it('repeats an unrecognised tool name verbatim rather than guessing at it', () => {
    expect(activityVerb('streaming', { toolName: 'some_future_tool' })).toBe(
      'Using some_future_tool…'
    );
  });

  it('falls back to "Working…" for a live turn with no reading at all', () => {
    // Guaranteed on every runtime by the lifecycle contract, which is why the
    // sidebar can always say something honest about a live turn.
    expect(activityVerb('streaming')).toBe('Working…');
    expect(activityVerb('streaming', null)).toBe('Working…');
  });

  it('says NOTHING for a session that is not doing anything', () => {
    // The bottom rung is silence. A verb that outlives its turn is a lie, and
    // the churn this whole architecture exists to prevent starts with one.
    expect(activityVerb('idle')).toBeNull();
    expect(activityVerb('interrupted')).toBeNull();
    expect(activityVerb(null)).toBeNull();
    expect(activityVerb(undefined)).toBeNull();
  });

  it('says nothing for an errored session, because Heads up is already saying it', () => {
    // A wedged session is a Heads up item (BC-5). Spending the row's second line on
    // it would say the same thing twice, in the weaker of the two places.
    expect(activityVerb('error')).toBeNull();
  });
});

/**
 * The rungs as one table (BC-37 validation criteria), plus the property that
 * matters more than any single row of it: **no branch invents a verb.**
 *
 * **The table encodes the SHIPPED contract, which the task text got wrong**
 * (DOR-1096). An unrecognised tool name does not fall back to "Working…" — it
 * is repeated verbatim as `Using <name>…`, and an MCP tool is named by its
 * server. Only a turn with *no reading at all* says "Working…". That is both
 * what `formatActivityLabel` does (verified by execution) and the better
 * product: a name you do not recognise still tells an operator more than a
 * generic verb, and repeating it is not the same as guessing at it. So the
 * table has five rows rather than four, and the extra one is the correction.
 *
 * The individual cases above pin the phrasing. This block pins the SHAPE — that
 * every lifecycle the wire can carry, crossed with every reading it can carry,
 * lands on a rung that already exists.
 *
 * To be precise about what that does and does not catch: a NEW lifecycle added
 * to `SessionLifecycleSchema` passes here by returning `null`, and that is the
 * right answer — "degrade down the ladder, never guess" means an unrecognised
 * state says nothing. What fails here is the opposite mistake, and the one
 * worth a test: a branch that answers a state with words the ladder never
 * agreed to say.
 */
describe('activityVerb — the ladder as a whole', () => {
  const KNOWN: SessionActivity = { toolName: 'Edit', target: 'sidebar-row.tsx' };
  const UNRECOGNISED: SessionActivity = { toolName: 'some_future_tool' };

  it.each([
    { rung: '1 · known tool', lifecycle: 'streaming' as const, activity: KNOWN, verb: 'Editing sidebar-row.tsx…' }, // prettier-ignore
    { rung: '2 · unrecognised tool', lifecycle: 'streaming' as const, activity: UNRECOGNISED, verb: 'Using some_future_tool…' }, // prettier-ignore
    { rung: '3 · no reading at all', lifecycle: 'streaming' as const, activity: null, verb: 'Working…' }, // prettier-ignore
    { rung: '4 · blocked', lifecycle: 'blocked' as const, activity: null, verb: 'waiting on you' },
    { rung: '5 · idle', lifecycle: 'idle' as const, activity: null, verb: null },
  ])('rung $rung → $verb', ({ lifecycle, activity, verb }) => {
    expect(activityVerb(lifecycle, activity)).toBe(verb);
  });

  it('names an unrecognised tool rather than falling back to "Working…"', () => {
    // The correction in one assertion (DOR-1096). "Working…" is reserved for a
    // turn the server has told us NOTHING about; a tool it has named but this
    // client has no phrase for is still a fact worth repeating.
    expect(activityVerb('streaming', UNRECOGNISED)).not.toBe('Working…');
    expect(activityVerb('streaming', { toolName: 'mcp__slack__send' })).toBe('Using Slack…');
    // …and the reserved case really is reserved for an empty reading.
    expect(activityVerb('streaming', { toolName: '   ' })).toBe('Working…');
  });

  it('gives every lifecycle on the wire a rung, and invents nothing for any of them', () => {
    // The permitted answers, exhaustively. Anything else is a verb the ladder
    // made up.
    const permitted = new Set([
      WAITING_ON_YOU_VERB,
      'Working…',
      'Editing sidebar-row.tsx…',
      'Using some_future_tool…',
      null,
    ]);
    const lifecycles = SessionLifecycleSchema.options as SessionLifecycle[];
    expect(lifecycles.length).toBeGreaterThanOrEqual(5);

    for (const lifecycle of lifecycles) {
      for (const activity of [null, undefined, KNOWN, UNRECOGNISED]) {
        expect(permitted, `${lifecycle} + ${JSON.stringify(activity)}`).toContain(
          activityVerb(lifecycle, activity)
        );
      }
    }
  });

  it('keeps its promise that a live turn always has something to say', () => {
    // The `'streaming' | 'blocked'` overload narrows the return to `string`, so
    // a caller inside a streaming branch needs no `?? fallback` — and a
    // fallback would be a second phrasing rule. The type cannot check itself at
    // runtime; this does.
    for (const activity of [null, undefined, KNOWN, { toolName: '' }, { toolName: '   ' }]) {
      for (const lifecycle of ['streaming', 'blocked'] as const) {
        const verb = activityVerb(lifecycle, activity);
        expect(typeof verb, `${lifecycle} + ${JSON.stringify(activity)}`).toBe('string');
        expect(verb.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
