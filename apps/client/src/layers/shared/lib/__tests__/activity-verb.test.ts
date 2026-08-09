import { describe, it, expect } from 'vitest';
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

  it('says nothing for an errored session, because Now is already saying it', () => {
    // A wedged session is a Now item (BC-5). Spending the row's second line on
    // it would say the same thing twice, in the weaker of the two places.
    expect(activityVerb('error')).toBeNull();
  });
});
