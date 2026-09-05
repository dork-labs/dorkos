/**
 * @vitest-environment jsdom
 */
/**
 * The leaf that holds the live verb — and the re-render budget that is the
 * reason it exists (spec R1, P2 AC-2, BC-37).
 *
 * The behaviour tests are the easy half. The interesting one is the last block:
 * a fleet of agents emits a tool reading every couple of seconds each, and the
 * whole design of the sidebar rests on one of those readings touching exactly
 * one text node. That claim is only worth anything if a test would notice it
 * becoming false, so the rows here count their own renders.
 *
 * @module entities/session/ui/__tests__/SessionVerbLine
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionActivity, SessionStatus } from '@dorkos/shared/session-stream';
import { SidebarRow } from '@/layers/shared/ui';
import { useSessionListStore } from '../../model/stream/session-list-store';
import { SessionVerbLine } from '../SessionVerbLine';

/** How many times each ROW has rendered, keyed by the id in its `dataSlot`. */
const { rowRenders } = vi.hoisted(() => ({ rowRenders: new Map<string, number>() }));

/**
 * Count `SidebarRow`'s OWN renders, by becoming it.
 *
 * A wrapper component around `<SidebarRow/>` cannot do this, and the difference
 * is the whole test. `SidebarRow` re-renders because of hooks it calls itself —
 * a `useSessionToolActivity` hoisted into it, a subscription to the whole
 * `statuses` map — and none of those touch a parent, so a wrapper's counter sits
 * still through exactly the regressions R1 exists to prevent. A `<Profiler>`
 * around it is no better in the other direction: it also fires when the verb
 * subtree inside commits, so it can never tell the two apart.
 *
 * Calling `actual.SidebarRow(props)` as a FUNCTION rather than rendering it as
 * JSX is what fixes it: there is then one component here, the counter and the
 * row are the same fiber, and the row's hooks are this function's hooks.
 */
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  return {
    ...actual,
    SidebarRow: (props: Parameters<typeof actual.SidebarRow>[0]) => {
      const id = props.dataSlot ?? 'unkeyed';
      rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1);
      return actual.SidebarRow(props);
    },
  };
});

/** A status carrying nothing but the two fields these tests are about. */
function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'streaming',
    lastError: null,
    ...overrides,
  };
}

/** Push one session's activity through the real store, as the stream would. */
function emitActivity(sessionId: string, activity: SessionActivity | undefined): void {
  act(() => {
    useSessionListStore.getState().applyListEvent({
      type: 'session_status',
      sessionId,
      status: status({ activity }),
    });
  });
}

beforeEach(() => {
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    contextReadings: {},
    unseen: {},
    rekeys: {},
  });
});

afterEach(() => cleanup());

describe('SessionVerbLine — the words, from activity', () => {
  it('names the tool the session is actually running', () => {
    emitActivity('s1', { toolName: 'Edit', target: 'sidebar-row.tsx' });
    render(<SessionVerbLine sessionId="s1" lifecycle="streaming" />);
    expect(screen.getByText('Editing sidebar-row.tsx…')).toBeInTheDocument();
  });

  it('follows the session as the tool changes, without being re-mounted', () => {
    emitActivity('s1', { toolName: 'Edit', target: 'sidebar-row.tsx' });
    render(<SessionVerbLine sessionId="s1" lifecycle="streaming" />);

    emitActivity('s1', { toolName: 'Bash', target: 'pnpm verify' });
    expect(screen.getByText('Running pnpm verify…')).toBeInTheDocument();
    expect(screen.queryByText('Editing sidebar-row.tsx…')).not.toBeInTheDocument();
  });

  it('says "Working…" for a live turn whose tool is unknown', () => {
    render(<SessionVerbLine sessionId="s1" lifecycle="streaming" />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('says nothing at all for an idle session, whatever the store still holds', () => {
    // Lifecycle is what decides silence. A reading that outlived its turn must
    // never reach the row — a verb that outlives its turn is a lie.
    emitActivity('s1', { toolName: 'Edit', target: 'sidebar-row.tsx' });
    const { container } = render(<SessionVerbLine sessionId="s1" lifecycle="idle" />);
    expect(container.textContent).toBe('');
  });
});

describe('SessionVerbLine — the re-render budget (R1, P2 AC-2)', () => {
  /** How many times each row's VERB SUBTREE has committed, keyed by session id. */
  const verbRenders = new Map<string, number>();

  /**
   * One sidebar row, exactly as the sidebar builds one: the verb arrives as a
   * node, and the subscription lives inside it.
   *
   * Two counters, two mechanisms, because they measure opposite things. The
   * ROW's renders are counted by the module mock above, which had to *become*
   * `SidebarRow` to see hooks the row calls on itself. The VERB's are counted
   * by a `<Profiler>`, which reports a subtree commit whoever inside caused it —
   * the right tool here precisely because the subscription is below this
   * component and a wrapper of my own would have nothing to count.
   *
   * `dataSlot` is what keys the row counter; it is the only id the mock sees.
   */
  function CountingRow({ sessionId }: { sessionId: string }) {
    return (
      <SidebarRow
        who="Scout"
        title={sessionId}
        dataSlot={sessionId}
        reservesVerbLine
        secondLine={
          <Profiler
            id={sessionId}
            onRender={(id) => verbRenders.set(id, (verbRenders.get(id) ?? 0) + 1)}
          >
            <SessionVerbLine sessionId={sessionId} lifecycle="streaming" />
          </Profiler>
        }
      />
    );
  }

  const IDS = ['s1', 's2', 's3', 's4'];

  beforeEach(() => {
    rowRenders.clear();
    verbRenders.clear();
    for (const id of IDS) emitActivity(id, { toolName: 'Read', target: `${id}.ts` });
    render(
      <>
        {IDS.map((id) => (
          <CountingRow key={id} sessionId={id} />
        ))}
      </>
    );
  });

  it('re-renders one verb, and only one, when one session reports a tool', () => {
    const before = new Map(verbRenders);
    emitActivity('s2', { toolName: 'Bash', target: 'pnpm verify' });

    expect(verbRenders.get('s2')).toBe((before.get('s2') ?? 0) + 1);
    for (const id of IDS.filter((entry) => entry !== 's2')) {
      expect(verbRenders.get(id), `${id} re-rendered for s2's activity`).toBe(before.get(id));
    }
    // And the words really did change, so the counter above is measuring a
    // subscription that works rather than one that is simply never called.
    expect(screen.getByText('Running pnpm verify…')).toBeInTheDocument();
  });

  it('re-renders NO row at all — not even the one the activity belongs to', () => {
    // This is stronger than the acceptance criterion asks for, and it is the
    // point of the arrangement. The subscription lives below the row, so an
    // activity event never touches the row's own tree: not its glyph, not its
    // title, not its menu, not its drag bindings.
    const before = new Map(rowRenders);

    // FIRST: prove the measurement happened at all. "It did not re-render" is
    // also true of a row that was never counted — drop `dataSlot` from
    // `CountingRow` and every row falls into one `'unkeyed'` bucket, every
    // lookup below returns `undefined`, and `expect(undefined).toBe(undefined)`
    // passes four times over. For any "X did not happen" assertion, assert that
    // X was observable in the first place.
    for (const id of IDS) {
      expect(
        before.get(id),
        `row ${id} was never counted, so nothing below means anything`
      ).toBeGreaterThan(0);
    }

    emitActivity('s2', { toolName: 'Bash', target: 'pnpm verify' });
    for (const id of IDS) {
      expect(rowRenders.get(id), `row ${id} re-rendered`).toBe(before.get(id));
    }
  });

  it('does not re-render anything when a status arrives carrying the same tool', () => {
    // The fleet stream re-sends a session's status for reasons that have
    // nothing to do with its tool. A row that woke up for each of those would
    // spend the whole budget on events that change no pixel.
    const before = new Map(verbRenders);
    emitActivity('s2', { toolName: 'Read', target: 's2.ts' });
    for (const id of IDS) {
      expect(verbRenders.get(id), `${id} woke for an unchanged reading`).toBe(before.get(id));
    }
  });

  it('proves the counters can move at all', () => {
    // A budget test that could never fail is worse than none: if these rows
    // simply did not subscribe, every assertion above would pass. So: an event
    // that DOES change this session's tool must move its counter.
    const before = verbRenders.get('s3') ?? 0;
    emitActivity('s3', { toolName: 'Grep', target: 'activityVerb' });
    expect(verbRenders.get('s3')).toBeGreaterThan(before);
  });
});
