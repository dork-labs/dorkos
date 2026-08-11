// @vitest-environment jsdom
/**
 * One definition of "live", pinned across the five surfaces that draw it
 * (DOR-1137, `design-decisions.md` §18).
 *
 * Heads up's "N working" line, a folded Library section's "N agents working" header,
 * ⌘K's Continue list, the presence strip Heads up's rollup NAVIGATES to, and the
 * badge an agent row actually draws are five renderings of one fact, and every
 * one of them used to compute it alone.
 *
 * **This test exists to catch the next drift as a set.** Each surface has its
 * own unit tests for its own rules; what none of them could see is two surfaces
 * given the same store state and answering differently. So one scenario is
 * built here — statuses, directories and session records, exactly as the
 * session-list store holds them — and driven through all five at once.
 *
 * **Every answer comes from the shipped code**, including the two that live
 * behind hooks: the real `useSessionListStore` is seeded and the real
 * `useAgentHottestStatus` is rendered against it. Re-deriving a surface's rule
 * here would produce a test that agrees with itself while the product drifts —
 * which is the failure this file is named after.
 *
 * It lives outside `layers/` on purpose: reaching into two sibling features is
 * something the app shell may do and a feature may not (FSD).
 *
 * @module __tests__/one-live-definition
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { useAgentHottestStatus, useSessionListStore } from '@/layers/entities/session';
import { selectContinueEntries } from '@/layers/features/command-palette/model/palette-recent';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { buildWorkingRollup } from '@/layers/features/dashboard-sidebar/model/rules/build-working-rollup';
import {
  agent,
  emptyState,
  prefs,
  session,
} from '@/layers/features/dashboard-sidebar/model/fixtures';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import { selectWorkingSessions } from '@/layers/features/presence-strip/lib/working-sessions';

vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, useReducedMotion: () => false };
});

/** The one agent every scenario's sessions belong to. */
const CWD = '/Users/dev/code/tangerine';

/**
 * One state of the session-list store — the single source all three surfaces
 * are handed, so nothing below can be fed a scenario the others never saw.
 */
interface StoreState {
  /** `statuses`: what the live stream says each session is doing. */
  statuses: Record<string, SessionStatus>;
  /** `statusCwds`: where each of those is running, from the same events. */
  statusCwds: Record<string, string>;
  /**
   * The session records either surface can see — the REST window plus the
   * stream's own metadata map. This is where `origin` lives, and a session
   * absent from it is one whose origin is unknown.
   */
  records: Session[];
}

/** A store state, with the empty case spelled once. */
function store(overrides: Partial<StoreState> = {}): StoreState {
  return { statuses: {}, statusCwds: {}, records: [], ...overrides };
}

/** A streaming status. */
const streaming: SessionStatus = { lifecycle: 'streaming' } as SessionStatus;

/**
 * The sidebar's snapshot of one store state, with its Agents section folded.
 *
 * Derived rather than written out, so the sidebar and the palette below cannot
 * be given subtly different worlds — which is the failure this whole file
 * exists to make impossible.
 *
 * @param state - The store state.
 */
function sidebarState(state: StoreState): SidebarState {
  return emptyState({
    agents: [agent(CWD)],
    displayNames: { [CWD]: 'tangerine' },
    sessions: state.records,
    // Exactly what `useSidebarState` derives: the streaming ids, and the
    // directory map the same events carried.
    workingSessionIds: Object.entries(state.statuses)
      .filter(([, status]) => status.lifecycle === 'streaming')
      .map(([id]) => id),
    liveSessionCwds: state.statusCwds,
    prefs: prefs({ sections: { agents: { collapsed: true } } }),
  });
}

/** What each surface says is live, from one store state. */
function whatEachSurfaceSays(state: StoreState) {
  const snapshot = sidebarState(state);
  const agents = buildSidebarModel(snapshot)
    .zones.find((zone) => zone.id === 'library')
    ?.sections.find((section) => section.id === 'agents');
  return {
    /** Heads up's "N working" row — the count it prints, or 0 when there is no row. */
    nowWorking: Number(buildWorkingRollup(snapshot)?.primary.split(' ')[0] ?? 0),
    /** The folded section header's count. */
    foldedWorking: agents?.rollup?.workingCount ?? 0,
    /** ⌘K's Continue rows, by session id. */
    continueIds: selectContinueEntries(state.statuses, state.records).map(
      (entry) => entry.sessionId
    ),
    /**
     * The presence strip's working half — where Heads up's rollup NAVIGATES, which
     * is why it belongs in this set rather than in a suite of its own
     * (`SidebarChrome` routes `rollup: 'working'` to the home surface).
     */
    stripWorking: selectWorkingSessions(state.statuses, state.statusCwds, recordsById(state))
      .map((entry) => entry.sessionId)
      .sort(),
    /**
     * What an agent row actually DRAWS. `agentRow`'s status is not rendered —
     * `SidebarModelRow` hands `AgentListItem` no status and no sessions, so the
     * badge comes from the live store through `useAgentHottestStatus`. A set
     * that omitted it would pin four surfaces and leave the visible one free to
     * drift (DOR-1137 review, B3).
     */
    rowBadge: agentBadgeKind(state),
  };
}

/** The store's session-metadata map, as the scenario's records. */
function recordsById(state: StoreState): Record<string, Session> {
  return Object.fromEntries(state.records.map((record) => [record.id, record]));
}

/**
 * The badge an agent row draws for {@link CWD}, from the real hook over the
 * real store.
 *
 * Seeded and rendered rather than re-derived: a rule that lives inside a hook
 * cannot be checked by writing the rule out a second time, which is the exact
 * shape of the drift this file is named after.
 *
 * @param state - The store state to seed.
 */
function agentBadgeKind(state: StoreState): string {
  useSessionListStore.setState({
    statuses: state.statuses,
    statusCwds: state.statusCwds,
    sessions: recordsById(state),
    unseen: {},
  });
  const { result, unmount } = renderHook(() => useAgentHottestStatus([], CWD));
  const kind = result.current.kind;
  unmount();
  return kind;
}

describe('§18 — five surfaces, one definition of live', () => {
  beforeEach(() => {
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
  });
  afterEach(() => cleanup());

  it('agree that a human conversation is running', () => {
    // The control. Every assertion below is about something being ABSENT, and
    // an absence proves nothing unless the same machinery can produce a
    // presence.
    const said = whatEachSurfaceSays(
      store({
        statuses: { 'ses-human': streaming },
        statusCwds: { 'ses-human': CWD },
        records: [session({ id: 'ses-human', title: 'Wire the model', cwd: CWD })],
      })
    );
    expect(said).toEqual({
      nowWorking: 1,
      foldedWorking: 1,
      continueIds: ['ses-human'],
      stripWorking: ['ses-human'],
      rowBadge: 'streaming',
    });
  });

  it('agree that an automated run is not', () => {
    // The defect, from both ends at once: this state used to yield
    // `{ nowWorking: 0, foldedWorking: 0, continueIds: ['ses-room'] }` — the
    // sidebar silent, ⌘K offering a verb-carrying row for the same session.
    const said = whatEachSurfaceSays(
      store({
        statuses: { 'ses-room': streaming },
        statusCwds: { 'ses-room': CWD },
        records: [session({ id: 'ses-room', title: '#team turn', cwd: CWD, origin: 'room' })],
      })
    );
    expect(said).toEqual({
      nowWorking: 0,
      foldedWorking: 0,
      continueIds: [],
      stripWorking: [],
      rowBadge: 'idle',
    });
  });

  it('pick out the same one from a mixed set', () => {
    const said = whatEachSurfaceSays(
      store({
        statuses: { 'ses-human': streaming, 'ses-task': streaming, 'ses-room': streaming },
        statusCwds: { 'ses-human': CWD, 'ses-task': CWD, 'ses-room': CWD },
        records: [
          session({ id: 'ses-human', title: 'Wire the model', cwd: CWD }),
          session({ id: 'ses-task', title: 'Nightly digest', cwd: CWD, origin: 'task' }),
          session({ id: 'ses-room', title: '#team turn', cwd: CWD, origin: 'room' }),
        ],
      })
    );
    expect(said).toEqual({
      nowWorking: 1,
      foldedWorking: 1,
      continueIds: ['ses-human'],
      stripWorking: ['ses-human'],
      rowBadge: 'streaming',
    });
  });

  it('agree about a turn the recent window has never seen', () => {
    // A session that started seconds ago has a status and a directory before it
    // has a record anywhere. All three count it — origin unknown is not origin
    // automated — and the folded header is the one that used to lose it, having
    // insisted on a record that does not exist yet.
    const said = whatEachSurfaceSays(
      store({ statuses: { 'ses-new': streaming }, statusCwds: { 'ses-new': CWD } })
    );
    expect(said).toEqual({
      nowWorking: 1,
      foldedWorking: 1,
      continueIds: ['ses-new'],
      stripWorking: ['ses-new'],
      rowBadge: 'streaming',
    });
  });

  it('leave a running session nobody can place out of the SECTION only', () => {
    // No directory anywhere: it belongs to no agent, so no section can claim
    // it. Heads up still says it is running, which is the honest half — a gap in
    // attribution is not a reason to tell the operator nothing is happening.
    const said = whatEachSurfaceSays(store({ statuses: { 'ses-nowhere': streaming } }));
    // The strip and the badge need a directory to draw anything at all, so both
    // are silent here for the same reason the section is.
    expect(said).toEqual({
      nowWorking: 1,
      foldedWorking: 0,
      continueIds: ['ses-nowhere'],
      stripWorking: [],
      rowBadge: 'idle',
    });
  });

  it('differ only where a documented rule says they should: blocked', () => {
    // Continue is a list of what to go back to, so it holds what has STOPPED
    // and is waiting on a person as well as what is streaming (BC-6's order).
    // Heads up's rollup counts streaming turns and lets `entities/attention` raise
    // the blocked one as its own item. The origin rule is identical across
    // both, which is what this file is here to hold; the lifecycle set is not,
    // and this is where that is written down.
    const state = store({
      statuses: { 'ses-blocked': { lifecycle: 'blocked' } as SessionStatus },
      statusCwds: { 'ses-blocked': CWD },
      records: [session({ id: 'ses-blocked', title: 'Which account?', cwd: CWD })],
    });
    const said = whatEachSurfaceSays(state);
    expect(said.continueIds).toEqual(['ses-blocked']);
    expect(said.nowWorking).toBe(0);

    // And the origin rule still holds over that difference: an automated
    // session that is blocked is in none of the three, Heads up included — it
    // reaches the operator as an attention signal instead.
    const automated = whatEachSurfaceSays({
      ...state,
      records: [session({ id: 'ses-blocked', title: 'Nightly digest', cwd: CWD, origin: 'task' })],
    });
    // …except the badge, and that is the carve-out working: liveness excludes
    // automation, attention does not. A wedged nightly task still lights the
    // row it belongs to (BC-19), while contributing to no count of what is
    // running.
    expect(automated).toEqual({
      nowWorking: 0,
      foldedWorking: 0,
      continueIds: [],
      stripWorking: [],
      rowBadge: 'pendingApproval',
    });
  });
});
