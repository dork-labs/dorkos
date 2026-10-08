/**
 * Dev Playground: the chat list, Switch session around it, and the fixture the
 * agent roster shares with them.
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
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { Button } from '@/layers/shared/ui';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { sessionKeys, useSessionListStore } from '@/layers/entities/session';
import { ChatList } from '@/layers/features/chat-list';
import { SessionSwitcher } from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_AGENTS, minutesAgo } from './agent-sidebar-fixtures';

// ── SessionSwitcher ──

/** The agent the switcher fixtures hang off. */
const SWITCHER_AGENT = MOCK_AGENTS[0];

/**
 * The long-named agent, given a chip of its own.
 *
 * It exists so the roster has a row whose title actually reaches the trailing
 * reservation — the case the chip's placement has to survive, and the one a
 * short name can never exercise. Its chip comes from {@link LIVE_BY_PATH}, the
 * same map the roster showcase spreads into every row.
 */
const LONG_NAME_AGENT = MOCK_AGENTS[3];

/**
 * Two live conversations for {@link LONG_NAME_AGENT} — the minimum the chip
 * needs, since one live session is not a choice and draws no chip.
 */
const LONG_NAME_SESSIONS: Session[] = [
  {
    id: 'sw-long-1',
    title: 'Reconcile August stock counts',
    createdAt: minutesAgo(90),
    updatedAt: minutesAgo(1),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: LONG_NAME_AGENT.path,
  },
  {
    id: 'sw-long-2',
    title: 'Chase the missing pallet',
    createdAt: minutesAgo(80),
    updatedAt: minutesAgo(6),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: LONG_NAME_AGENT.path,
  },
];

/** Started by another chat of this agent's, for a spin-off fixture. */
function startedFrom(sessionId: string, title: string | null): Session['startedBy'] {
  return { kind: 'chat', sessionId, title, reason: null, permission: null };
}

/** The base every switcher fixture shares. */
const BASE = {
  permissionMode: 'default',
  runtime: 'claude-code',
  cwd: SWITCHER_AGENT.path,
} as const;

/**
 * The chats the chat-list showcases run on: every case the list has to draw
 * (spec `your-activity-first` D11, D14). Two chats running, one waiting on you
 * and one whose account ran out; a chat with three spin-offs (one running, one done, one lifted because it
 * needs you); a spin-off you opened, so it is a row of its own; a spin-off whose
 * parent is gone; chats you used yesterday and last week; one on another
 * runtime, so rows name theirs; and three automated chats from a schedule, a
 * room and Telegram.
 */
const SWITCHER_SESSIONS: Session[] = [
  {
    ...BASE,
    id: 'sw-live-1',
    title: 'Dashboard overhaul',
    createdAt: minutesAgo(200),
    updatedAt: minutesAgo(0),
    lastTouchedByYouAt: minutesAgo(12),
  },
  {
    ...BASE,
    id: 'sw-live-2',
    title: 'Release notes draft',
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(1),
    lastTouchedByYouAt: minutesAgo(3),
  },
  {
    ...BASE,
    id: 'sw-ask',
    title: 'Ship the pricing page',
    createdAt: minutesAgo(300),
    updatedAt: minutesAgo(8),
    lastTouchedByYouAt: minutesAgo(40),
  },
  {
    ...BASE,
    id: 'sw-out',
    title: 'Rewrite the onboarding emails',
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(50),
    lastTouchedByYouAt: minutesAgo(55),
    // Its account ran out and nothing has been decided yet: "Out of usage".
    status: {
      lifecycle: 'idle',
      limit: {
        accountId: 'acct-2',
        window: 'five_hour',
        resetsAt: minutesAgo(-120),
        since: minutesAgo(50),
        plan: { mode: 'ask' },
        scope: 'account',
        state: 'limited',
      },
    },
  },
  {
    ...BASE,
    id: 'sw-plan',
    title: 'Plan the launch week',
    createdAt: minutesAgo(500),
    updatedAt: minutesAgo(20),
    lastTouchedByYouAt: minutesAgo(25),
  },
  {
    ...BASE,
    id: 'sw-spin-1',
    title: 'Draft the launch email',
    origin: 'agent',
    createdAt: minutesAgo(22),
    updatedAt: minutesAgo(0),
    startedBy: startedFrom('sw-plan', 'Plan the launch week'),
  },
  {
    ...BASE,
    id: 'sw-spin-2',
    title: 'Check every docs link',
    origin: 'agent',
    createdAt: minutesAgo(22),
    updatedAt: minutesAgo(15),
    startedBy: startedFrom('sw-plan', 'Plan the launch week'),
  },
  {
    ...BASE,
    id: 'sw-spin-3',
    title: 'Price the ad test',
    origin: 'agent',
    createdAt: minutesAgo(21),
    updatedAt: minutesAgo(5),
    startedBy: startedFrom('sw-plan', 'Plan the launch week'),
  },
  {
    ...BASE,
    id: 'sw-spin-opened',
    title: 'Summarise customer calls',
    origin: 'agent',
    createdAt: minutesAgo(400),
    updatedAt: minutesAgo(130),
    lastTouchedByYouAt: minutesAgo(120),
    startedBy: startedFrom('sw-plan', 'Plan the launch week'),
  },
  {
    ...BASE,
    id: 'sw-orphan',
    title: 'Tidy the backlog',
    origin: 'agent',
    createdAt: minutesAgo(2000),
    updatedAt: minutesAgo(1900),
    startedBy: startedFrom('sw-gone', 'Weekly review'),
  },
  {
    ...BASE,
    id: 'sw-recent-1',
    title: 'Review help & feedback options',
    createdAt: minutesAgo(1800),
    updatedAt: minutesAgo(1500),
    lastTouchedByYouAt: minutesAgo(1440),
  },
  {
    ...BASE,
    id: 'sw-recent-2',
    title: 'Fix flaky sidebar test',
    createdAt: minutesAgo(9000),
    updatedAt: minutesAgo(8000),
    userLastMessageAt: minutesAgo(8100),
  },
  {
    ...BASE,
    id: 'sw-codex',
    title: 'Port the CSV importer',
    runtime: 'codex',
    createdAt: minutesAgo(5000),
    updatedAt: minutesAgo(4300),
    lastTouchedByYouAt: minutesAgo(4320),
  },
  {
    ...BASE,
    id: 'sw-auto-1',
    title: 'Nightly changelog sweep',
    createdAt: minutesAgo(700),
    updatedAt: minutesAgo(360),
    origin: 'task',
    originLabel: 'Scheduled task · nightly',
  },
  {
    ...BASE,
    id: 'sw-auto-2',
    title: 'Answer in #launch',
    createdAt: minutesAgo(900),
    updatedAt: minutesAgo(600),
    origin: 'room',
    originLabel: '#launch',
  },
  {
    ...BASE,
    id: 'sw-auto-3',
    title: 'Telegram · Dorian',
    createdAt: minutesAgo(3000),
    updatedAt: minutesAgo(2880),
    origin: 'channel',
    originLabel: 'Telegram',
  },
];

/** The chats the fixture reports as running, and what each is doing. */
const SWITCHER_LIVE: { id: string; toolName: string; target: string }[] = [
  { id: 'sw-live-1', toolName: 'Edit', target: 'RoomRow.tsx' },
  { id: 'sw-live-2', toolName: 'Read', target: 'CHANGELOG.md' },
  { id: 'sw-spin-1', toolName: 'Write', target: 'launch-email.md' },
];

/** The chats the fixture reports as waiting on you. */
const SWITCHER_BLOCKED: readonly string[] = ['sw-ask', 'sw-spin-3'];

/**
 * How many live sessions each fixture agent has, for the roster row's chip.
 *
 * **Counted from the fixtures rather than written down beside them.** The row
 * no longer counts for itself — `AgentListItem` draws whatever `liveCount` the
 * sidebar model hands it (`SidebarRowModel.liveCount`, `library-rows.ts`) — so
 * the playground has to state the number the model would have produced. A
 * literal here could drift from the sessions seeded below and give a row a chip
 * whose switcher then opens on a different count; deriving it means adding a
 * live session to either list moves both at once.
 *
 * Only these two agents are live. A path that is absent gets no chip, which is
 * the model's own contract: absence, never a zero.
 */
export const LIVE_BY_PATH: Readonly<Record<string, number>> = {
  [SWITCHER_AGENT.path]: SWITCHER_LIVE.length,
  [LONG_NAME_AGENT.path]: LONG_NAME_SESSIONS.length,
};

/** A live status in the shape the session stream sends, at `lifecycle`. */
function liveStatus(lifecycle: 'streaming' | 'blocked'): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
    lastError: null,
    limit: null,
    accountUsage: null,
  };
}

/**
 * Seed the two real stores the switcher reads, so the playground exercises the
 * production data path instead of a prop-fed lookalike: the query cache
 * `useAgentSessions` reads, and the global session-list store the lifecycle and
 * the verbs come off.
 *
 * Seeded on mount and torn down on unmount, so leaving the page leaves no
 * phantom live sessions behind for the rest of the playground.
 *
 * **Metadata AND status, because the real stream sends both**, and both are
 * for the SWITCHER now rather than for the row's chip. The dialog reads the
 * query cache for its rows and the session-list store for each row's lifecycle
 * and verb; a fixture that set a status alone would describe a state production
 * never produces (live, but of unknowable origin). Upserting first is what the
 * server does.
 *
 * **The row's chip is not seeded here and cannot be.** `AgentListItem` stopped
 * counting live sessions off this store when the sidebar model became the one
 * place that count is decided; the roster showcase passes it as a prop from
 * {@link LIVE_BY_PATH} instead, which is derived from the very sessions this
 * function seeds — so the chip's number and the dialog's rows still come from
 * one fixture.
 */
export function useSwitcherFixture(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.setQueryData(sessionKeys.list(SWITCHER_AGENT.path), SWITCHER_SESSIONS);
    queryClient.setQueryData(sessionKeys.list(LONG_NAME_AGENT.path), LONG_NAME_SESSIONS);
    const store = useSessionListStore.getState();
    for (const session of [...SWITCHER_SESSIONS, ...LONG_NAME_SESSIONS]) {
      store.upsertSession(session);
    }
    for (const session of LONG_NAME_SESSIONS) {
      store.setSessionStatus(session.id, liveStatus('streaming'), LONG_NAME_AGENT.path);
    }
    for (const { id, toolName, target } of SWITCHER_LIVE) {
      store.setSessionStatus(
        id,
        { ...liveStatus('streaming'), activity: { toolName, target } },
        SWITCHER_AGENT.path
      );
    }
    for (const id of SWITCHER_BLOCKED) {
      store.setSessionStatus(id, liveStatus('blocked'), SWITCHER_AGENT.path);
    }
    return () => {
      // `removeSession` drops the metadata, the status and the cwd together, so
      // every session seeded above is swept whether or not it was ever live.
      for (const { id } of [...SWITCHER_SESSIONS, ...LONG_NAME_SESSIONS]) {
        useSessionListStore.getState().removeSession(id);
      }
      queryClient.removeQueries({ queryKey: sessionKeys.list(SWITCHER_AGENT.path) });
      queryClient.removeQueries({ queryKey: sessionKeys.list(LONG_NAME_AGENT.path) });
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
 * (`DevPlayground`, whose memory history lands on `PLAYGROUND_ROUTER_PATH`), so a
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
      description="Switch session: the shared ChatList on one responsive surface, a dialog on the desktop and a bottom sheet on a phone. ↵ opens, ⌘↵ starts a new chat, ⇧↵ forks."
    >
      <ShowcaseLabel>Open the switcher</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col items-start gap-3">
          <Button size="sm" onClick={() => setOpen(true)}>
            Open {SWITCHER_AGENT.displayName}’s chats
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
        onSelectSession={(sessionId) => setLastAction(`open ${sessionId}`)}
        onNewSession={() => setLastAction('new chat')}
      />
    </PlaygroundSection>
  );
}

/**
 * The chat list on its own, as Profile → Sessions draws it: search on, over the
 * same seeded stores Switch session reads, so the two showcases cannot drift.
 */
export function ChatListShowcase() {
  const [lastAction, setLastAction] = useState<string | null>(null);
  useSwitcherFixture();

  return (
    <PlaygroundSection
      title="ChatList"
      description="One agent's chats, drawn by Profile → Sessions and Switch session alike. Needs you first, then running chats, then the rest by when you last used them. Spin-offs fold under the chat that started them; one that needs you is lifted out. Automated chats fold into one group."
    >
      <ShowcaseLabel>
        Every case: needs you, running, spin-offs, automated, two runtimes
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex h-[620px] w-full max-w-[440px] flex-col">
          <ChatList
            agentPath={SWITCHER_AGENT.path}
            agentName={SWITCHER_AGENT.displayName}
            onOpenChat={(sessionId) => setLastAction(`open ${sessionId}`)}
            onNewChat={() => setLastAction('new chat')}
            searchable
            className="min-h-0 flex-1"
          />
        </div>
      </ShowcaseDemo>
      {lastAction !== null && (
        <p className="text-muted-foreground text-xs">
          Last action: <span data-slot="chat-list-last-action">{lastAction}</span>
        </p>
      )}

      <ShowcaseLabel>No chats yet</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-[440px]">
          <ChatList
            agentPath={null}
            agentName={SWITCHER_AGENT.displayName}
            sessions={[]}
            onOpenChat={() => {}}
            onNewChat={() => setLastAction('new chat')}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
