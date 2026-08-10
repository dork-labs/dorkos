/**
 * Dev Playground: the session switcher, and the fixture the agent roster shares
 * with it.
 *
 * Split out of `AgentSidebarShowcases` when that file crossed its 500-line
 * limit. The fixture lives here rather than there because it is the switcher's
 * data: the roster showcase borrows it only so its first row can show the
 * "N live" chip that opens this surface.
 *
 * @module dev/showcases/SessionSwitcherShowcases
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Session } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { sessionKeys, useSessionListStore } from '@/layers/entities/session';
import { SessionSwitcher } from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_AGENTS, minutesAgo } from './agent-sidebar-fixtures';

// ── SessionSwitcher ──

/** The agent the switcher fixtures hang off. */
const SWITCHER_AGENT = MOCK_AGENTS[0];

/**
 * The sessions the switcher showcase runs on — three concurrent live turns, two
 * settled conversations, and two automated runs wearing different origin marks.
 *
 * Three live sessions on one agent is the case BC-35 is most specific about:
 * they are three rows, never a "3 sessions" rollup.
 */
const SWITCHER_SESSIONS: Session[] = [
  {
    id: 'sw-live-1',
    title: 'Dashboard overhaul',
    createdAt: minutesAgo(200),
    updatedAt: minutesAgo(0),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
  },
  {
    id: 'sw-live-2',
    title: 'Release notes draft',
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(3),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
  },
  {
    id: 'sw-live-3',
    title: 'Flaky sidebar spec',
    createdAt: minutesAgo(160),
    updatedAt: minutesAgo(4),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
  },
  {
    id: 'sw-recent-1',
    title: 'Review help & feedback options',
    createdAt: minutesAgo(400),
    updatedAt: minutesAgo(26),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
    lastMessagePreview: 'Settled on a two-tier submit flow',
  },
  {
    id: 'sw-recent-2',
    title: 'Fix flaky sidebar test',
    createdAt: minutesAgo(2000),
    updatedAt: minutesAgo(1500),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
    lastMessagePreview: 'Landed in PR #877',
  },
  {
    id: 'sw-auto-1',
    title: 'Nightly changelog sweep',
    createdAt: minutesAgo(700),
    updatedAt: minutesAgo(360),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
    origin: 'task',
    originLabel: 'Scheduled task · nightly',
  },
  {
    id: 'sw-auto-2',
    title: 'Telegram · Dorian',
    createdAt: minutesAgo(3000),
    updatedAt: minutesAgo(2880),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: SWITCHER_AGENT.path,
    origin: 'channel',
    originLabel: 'Telegram',
  },
];

/** The two sessions the fixture reports as streaming, and what they are doing. */
const SWITCHER_LIVE: { id: string; toolName: string; target: string }[] = [
  { id: 'sw-live-1', toolName: 'Edit', target: 'RoomRow.tsx' },
  { id: 'sw-live-2', toolName: 'Read', target: 'CHANGELOG.md' },
  { id: 'sw-live-3', toolName: 'Bash', target: 'pnpm test' },
];

/**
 * Seed the two real stores the switcher reads, so the playground exercises the
 * production data path instead of a prop-fed lookalike: the query cache
 * `useAgentSessions` reads, and the global session-list store the lifecycle and
 * the verbs come off.
 *
 * Seeded on mount and torn down on unmount, so leaving the page leaves no
 * phantom live sessions behind for the rest of the playground.
 *
 * **Metadata AND status, because the real stream sends both.** The chip counts
 * only human-origin sessions, and origin lives on the metadata a
 * `session_upserted` carries — so a fixture that set a status alone described a
 * state production never produces (live, but of unknowable origin) and drew no
 * chip at all. Upserting first is what the server does; the fixture now does it
 * too.
 */
export function useSwitcherFixture(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.setQueryData(sessionKeys.list(SWITCHER_AGENT.path), SWITCHER_SESSIONS);
    const store = useSessionListStore.getState();
    for (const session of SWITCHER_SESSIONS) store.upsertSession(session);
    for (const { id, toolName, target } of SWITCHER_LIVE) {
      store.setSessionStatus(
        id,
        {
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
          activity: { toolName, target },
        },
        SWITCHER_AGENT.path
      );
    }
    return () => {
      // `removeSession` drops the metadata, the status and the cwd together, so
      // every session seeded above is swept whether or not it was ever live.
      for (const { id } of SWITCHER_SESSIONS) useSessionListStore.getState().removeSession(id);
      queryClient.removeQueries({ queryKey: sessionKeys.list(SWITCHER_AGENT.path) });
    };
  }, [queryClient]);
}

/** The fixture session the showcase pretends is open, so the tag has a target. */
const CURRENT_SESSION_ID = 'sw-live-2';

/**
 * Make one fixture session read as "the one you have open", so the showcase can
 * actually demonstrate the `current` tag.
 *
 * The tag is not a prop — the switcher asks `useSessionId()`, which reads
 * `?session=` off the router. The playground runs its OWN memory router
 * (`DevPlayground`, `createMemoryHistory({ initialEntries: ['/dev'] })`), so a
 * param typed into the browser's address bar never reaches it, and the required
 * "current-session-tagged" state measured zero tagged rows.
 *
 * Writing the param into the playground's own router drives the REAL mechanism
 * — URL → `useSessionId` → the tag — rather than adding a demo-only prop to the
 * production component. It is scoped to while the dialog is open and unwound on
 * close, so no other showcase ever sees a session it did not ask for.
 *
 * @param open - Whether the switcher is currently up.
 */
function useCurrentSessionInPlayground(open: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    // `useNavigate` is typed against the APP router — the one the `Register`
    // interface declares — but inside the playground it resolves the dev memory
    // router, whose root route validates no search at all. The two search shapes
    // cannot be reconciled at the type level, so the reducer is cast. This is
    // dev-only code and the cast is the whole of the compromise.
    const navigateInPlayground = navigate as unknown as (options: {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    }) => void;
    navigateInPlayground({
      search: (previous) => ({
        ...previous,
        session: open ? CURRENT_SESSION_ID : undefined,
      }),
    });
  }, [open, navigate]);
}

/**
 * The switcher itself, opened from a button, over the seeded fixture.
 *
 * `lastAction` is the part that makes the footer keys checkable rather than
 * merely visible: a browser can press `↵`, `⌘↵` and `⇧↵` and read back which
 * one the surface actually ran, instead of watching three keys all close the
 * dialog and calling that proof.
 */
export function SessionSwitcherShowcase() {
  const [open, setOpen] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  useSwitcherFixture();
  useCurrentSessionInPlayground(open);

  return (
    <PlaygroundSection
      title="SessionSwitcher"
      description="An agent's depth, on one responsive surface — a dialog on the desktop, a bottom sheet on a phone. Live now (three concurrent turns, each with its verb), Recent (one-line outcomes), Automated (collapsed, origin-marked). ↵ continues, ⌘↵ starts a new session, ⇧↵ forks."
    >
      <ShowcaseLabel>Open the switcher</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col items-start gap-3">
          <Button size="sm" onClick={() => setOpen(true)}>
            Open {SWITCHER_AGENT.displayName} sessions
          </Button>
          <p className="text-muted-foreground text-xs">
            Narrow the window below 768px to see the same content as a bottom sheet.
          </p>
          {lastAction !== null && (
            <p className="text-muted-foreground text-xs">
              Last action: <span data-slot="switcher-last-action">{lastAction}</span>
            </p>
          )}
        </div>
      </ShowcaseDemo>
      <SessionSwitcher
        agentPath={SWITCHER_AGENT.path}
        agentName={SWITCHER_AGENT.displayName}
        agentVisual={resolveAgentVisual({ id: SWITCHER_AGENT.path })}
        open={open}
        onOpenChange={setOpen}
        onSelectSession={(sessionId) => setLastAction(`continue ${sessionId}`)}
        onNewSession={() => setLastAction('new session')}
      />
    </PlaygroundSection>
  );
}
