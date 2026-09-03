/**
 * Where an agent's depth lives, now that its row does not hold any.
 *
 * An agent is a teammate, not a folder: clicking one opens the conversation you
 * were having (BC-34), and everything else that agent has ever run moves here —
 * one responsive surface, a dialog on the desktop and a bottom sheet on a phone
 * (BC-35). It replaces the inline three-session panel the roster row used to
 * unfold, which could show three of fourteen sessions, could not say what any of
 * them was doing, and made a teammate look like a directory.
 *
 * Three groups, always in this order:
 *
 * - **Live now** — turns in flight, each with its verb. Concurrent sessions are
 *   simply several rows; there is no rollup, because "3 sessions" is not
 *   something you can click on and "Editing sidebar-row.tsx…" is.
 * - **Recent** — settled conversations with the last thing that happened in them.
 * - **Automated** — everything that started without you, collapsed behind a
 *   reveal and wearing its origin mark. Human attention is the scarce resource;
 *   automation does not get to spend it by default.
 *
 * @module features/dashboard-sidebar/ui/SessionSwitcher
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { Session } from '@dorkos/shared/types';
import type { SessionOrigin } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { useIsMobile, useTransport } from '@/layers/shared/model';
import {
  Button,
  Kbd,
  ORIGIN_GLYPH,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  SidebarMenu,
  SidebarRow,
  statusDotClass,
} from '@/layers/shared/ui';
import { AgentAvatar, type AgentVisual } from '@/layers/entities/agent';
import {
  partitionSessionsByOrigin,
  sessionDisplayTitle,
  sessionKeys,
  SessionVerbLine,
  useAgentSessions,
} from '@/layers/entities/session';
import { isLiveLifecycle, useSessionLifecycles } from '../model/use-live-sessions';

/**
 * The `data-slot` every session row in the switcher answers to.
 *
 * One name for the rows, so a test and a page object can find them without
 * knowing which group they landed in — which is the point, since the group a
 * session sits in is exactly what this component decides.
 */
export const SWITCHER_ROW_SLOT = 'session-switcher-row';

/** Props for {@link SessionSwitcher}. */
export interface SessionSwitcherProps {
  /** The agent's project directory — the membership key for its sessions. */
  agentPath: string;
  /** What the agent is called, for the surface's own heading. */
  agentName: string;
  /** The agent's face, resolved by whoever is opening this. */
  agentVisual: AgentVisual;
  /** Whether the surface is up. */
  open: boolean;
  /** Raise or lower it. */
  onOpenChange: (open: boolean) => void;
  /**
   * Continue a session — the `↵` in the footer.
   *
   * A prop rather than a navigation of its own because the two call sites move
   * the cockpit differently: the sidebar goes through the row chrome's
   * `openTarget` (which records the visit), the command palette through its own
   * select handler (which also closes itself and records frecency).
   */
  onSelectSession: (sessionId: string) => void;
  /** Start a fresh conversation with this agent — the `⌘↵` in the footer. */
  onNewSession: () => void;
}

/**
 * An agent's sessions, grouped, with the current one tagged.
 *
 * @param props - The agent, the surface's open state, and what its two
 *   navigating footer keys do.
 */
export function SessionSwitcher({
  agentPath,
  agentName,
  agentVisual,
  open,
  onOpenChange,
  onSelectSession,
  onNewSession,
}: SessionSwitcherProps) {
  // `null` while closed, so a switcher that has never been opened costs no
  // request — the roster mounts one of these per agent row with a live chip.
  const { sessions, isLoading, activeSessionId } = useAgentSessions(open ? agentPath : null);
  const transport = useTransport();
  const queryClient = useQueryClient();
  // Read here as well as inside `ResponsiveDialog`: the surface's SHAPE is that
  // component's business, but which affordance the footer slot carries is this
  // one's, and both answers come from the same source so they cannot disagree.
  const isMobile = useIsMobile();
  const [automatedOpen, setAutomatedOpen] = useState(false);

  const { conversations, automated } = useMemo(
    () => partitionSessionsByOrigin(sessions),
    [sessions]
  );
  // Positional, so the zip below cannot drift: one array in, one array out.
  const conversationIds = useMemo(() => conversations.map((s) => s.id), [conversations]);
  const lifecycles = useSessionLifecycles(conversationIds);

  const { live, recent } = useMemo(() => {
    const liveSessions: Session[] = [];
    const recentSessions: Session[] = [];
    conversations.forEach((session, index) => {
      if (isLiveLifecycle(lifecycles[index])) liveSessions.push(session);
      else recentSessions.push(session);
    });
    return { live: liveSessions, recent: recentSessions };
  }, [conversations, lifecycles]);

  const lifecycleOf = useCallback(
    (sessionId: string) => lifecycles[conversationIds.indexOf(sessionId)] ?? null,
    [conversationIds, lifecycles]
  );

  // Which session a row's button belongs to — how a modified `↵` finds out
  // WHICH row the operator is standing on. The rows are `SidebarRow`s and that
  // primitive publishes exactly one hook into its button (`buttonRef`), so
  // identity is carried here rather than smuggled into a data attribute.
  //
  // **Keyed by the ELEMENT, in a `WeakMap`, and that is not a micro-optimisation
  // — it is the only ordering-proof shape.** The obvious version is a
  // `Map<sessionId, element>` whose ref callback deletes the id when React hands
  // it `null`. That breaks the moment a row MOVES between groups, which is the
  // switcher's normal life: a turn starts, the row leaves Recent and joins Live
  // now, React mounts the new node BEFORE detaching the old one, and the stale
  // node's cleanup deletes the entry the fresh one just wrote. The map ends up
  // empty and `⇧↵` silently does nothing.
  //
  // An element belongs to exactly one session for as long as it exists, so
  // keying that way makes the question order-independent, and a `WeakMap` needs
  // no cleanup at all — a detached button is collectable, entry and all.
  const rowSessions = useRef(new WeakMap<HTMLButtonElement, string>());
  const registerRow = useCallback(
    (sessionId: string) => (element: HTMLButtonElement | null) => {
      if (element !== null) rowSessions.current.set(element, sessionId);
    },
    []
  );

  const handleContinue = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
      onOpenChange(false);
    },
    [onOpenChange, onSelectSession]
  );

  const handleNew = useCallback(() => {
    onNewSession();
    onOpenChange(false);
  }, [onNewSession, onOpenChange]);

  // Fork is answered here rather than handed in, because the footer promises it
  // unconditionally: a hint that reads `⇧ fork` beside a call site that forgot
  // to pass a handler is a lie the surface tells about itself.
  const handleFork = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, agentPath);
        await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
        onSelectSession(forked.id);
        onOpenChange(false);
      } catch (error) {
        // A headline a person can read, with the machine's own words underneath
        // — the shape `notifySessionLookupFailed` already uses. The raw message
        // is worth showing (a server says useful things) but is not worth
        // BEING the sentence: a fork that fails on a TypeError would otherwise
        // greet the operator with "Cannot read properties of null".
        toast.error("Couldn't branch off this conversation.", {
          description: error instanceof Error ? error.message : 'The original is untouched.',
        });
      }
    },
    [agentPath, onOpenChange, onSelectSession, queryClient, transport]
  );

  /**
   * The two modified `↵`s, caught before the browser turns them into a click.
   *
   * A focused `<button>` activates on `Enter` no matter which modifiers are
   * held, so `⌘↵` and `⇧↵` would BOTH continue the focused session unless the
   * keydown is taken here and defaulted away. Plain `↵` is deliberately
   * untouched — the row is a real button and continuing is what it already does.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter') return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        handleNew();
        return;
      }
      if (!event.shiftKey) return;
      const sessionId =
        event.target instanceof HTMLButtonElement
          ? rowSessions.current.get(event.target)
          : undefined;
      if (sessionId === undefined) return;
      event.preventDefault();
      void handleFork(sessionId);
    },
    [handleFork, handleNew]
  );

  const renderRow = useCallback(
    (session: Session, kind: 'live' | 'recent' | 'automated') => {
      const isCurrent = session.id === activeSessionId;
      const lifecycle = kind === 'live' ? lifecycleOf(session.id) : null;
      return (
        <SidebarRow
          key={session.id}
          dataSlot={SWITCHER_ROW_SLOT}
          buttonRef={registerRow(session.id)}
          title={sessionDisplayTitle(session.title)}
          isActive={isCurrent}
          onSelect={() => handleContinue(session.id)}
          {...(kind === 'automated'
            ? { glyph: <OriginMark origin={session.origin} label={session.originLabel} /> }
            : {})}
          {...(kind === 'live'
            ? {
                reservesVerbLine: true,
                secondLine: <SessionVerbLine sessionId={session.id} lifecycle={lifecycle} />,
              }
            : { preview: session.lastMessagePreview ?? null })}
          trailing={
            <>
              <span className="text-sidebar-foreground/50 text-2xs tabular-nums">
                {formatRelativeTime(session.updatedAt)}
              </span>
              {isCurrent && (
                <span
                  data-slot="session-switcher-current"
                  className="border-sidebar-border text-sidebar-foreground/70 rounded border px-1 py-px text-3xs leading-none"
                >
                  current
                </span>
              )}
            </>
          }
        />
      );
    },
    [activeSessionId, handleContinue, lifecycleOf, registerRow]
  );

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        // `min-h-0` overrides `ResponsiveDialogContent`'s own `min-h-[50vh]`,
        // which is right for a form and wrong for a list: an agent with no
        // conversations rendered a 420×450 box holding one sentence. The surface
        // is as tall as what it has to say.
        className="min-h-0 max-w-[420px] gap-0 p-0 sm:max-w-[420px]"
        aria-label={`${agentName} sessions`}
        onKeyDown={handleKeyDown}
      >
        <ResponsiveDialogHeader className="px-4 pt-4 pb-2 text-left">
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <AgentAvatar color={agentVisual.color} emoji={agentVisual.emoji} size="xs" />
            {agentName} — sessions
            <span className="text-muted-foreground ml-auto text-2xs font-normal tabular-nums">
              {sessions.length} total
            </span>
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="pb-2">
          {isLoading && sessions.length === 0 && (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              <span className="animate-pulse">Loading…</span>
            </p>
          )}

          {!isLoading && sessions.length === 0 && (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              No conversations yet. Press <Kbd>⌘↵</Kbd> to start one.
            </p>
          )}

          {live.length > 0 && (
            <SwitcherGroup label="Live now">
              {live.map((session) => renderRow(session, 'live'))}
            </SwitcherGroup>
          )}

          {recent.length > 0 && (
            <SwitcherGroup label="Recent">
              {recent.map((session) => renderRow(session, 'recent'))}
            </SwitcherGroup>
          )}

          {automated.length > 0 && (
            <SwitcherGroup label="Automated">
              <li>
                <button
                  type="button"
                  aria-expanded={automatedOpen}
                  onClick={() => setAutomatedOpen((previous) => !previous)}
                  className="text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex min-h-7 w-full items-center rounded-md px-2 text-left text-[13px] transition-colors duration-100"
                >
                  {automatedOpen ? 'Hide' : `+ ${automated.length} automated`}
                </button>
              </li>
              {automatedOpen && automated.map((session) => renderRow(session, 'automated'))}
            </SwitcherGroup>
          )}
        </ResponsiveDialogBody>

        {/*
          The legend names keys, so it appears only where there are keys to
          name. `Kbd` is already `hidden md:inline-flex`, and on a phone that
          left the three glyphs out and the three verbs in — a footer reading
          "continue new session fork", which is not a legend but three orphaned
          words. A browser found that; a spec could not. So the phone gets the
          one action the legend's middle hint stands for, in the vocabulary of a
          surface you touch.

          **Branched in JS, not in CSS, and the difference is the point.** The
          first fix was `hidden md:flex` beside `md:hidden`, which leaves BOTH in
          the DOM and hides one by stylesheet — so jsdom sees two footers, a test
          asserting "the legend is gone on a phone" passes either way, and the
          guard is worthless. `ResponsiveDialog` itself branches on
          `useIsMobile()` for exactly this reason; this follows it, and exactly
          one of the two is ever rendered.
        */}
        {isMobile ? (
          <div className="px-4 pt-1 pb-4">
            <Button variant="outline" className="w-full" onClick={handleNew}>
              <Plus className="size-4" />
              New session
            </Button>
          </div>
        ) : (
          <footer className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 pb-4 text-2xs">
            <span>
              <Kbd>↵</Kbd> continue
            </span>
            <span>
              <Kbd>⌘↵</Kbd> new session
            </span>
            <span>
              <Kbd>⇧↵</Kbd> fork
            </span>
          </footer>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** One labelled group of rows. */
function SwitcherGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="text-muted-foreground px-2 pt-3 pb-1 text-3xs font-semibold tracking-[0.05em] uppercase">
        {label}
      </h3>
      <SidebarMenu>{children}</SidebarMenu>
    </section>
  );
}

/**
 * How a session that started without you is marked.
 *
 * Straight off the shared registry (BC-26), never a local icon choice: Today's
 * rows, "+N automated", ⌘K and Activity draw these same five marks, and the
 * first time one of them picked its own the vocabulary stopped being learnable.
 *
 * @param props - The session's origin and its human-readable descriptor.
 */
function OriginMark({ origin, label }: { origin?: SessionOrigin; label?: string }) {
  // `user` is not in the registry, and its absence is the signal — an ordinary
  // conversation is unmarked. A session in this group always has a non-user
  // origin (that is what `partitionSessionsByOrigin` sorted on), so this guard
  // is for the type rather than for a state that occurs.
  if (origin === undefined || origin === 'user') return null;
  const Glyph = ORIGIN_GLYPH[origin];
  return (
    <Glyph
      className="text-sidebar-foreground/50 size-3"
      aria-label={label ?? `${origin} session`}
    />
  );
}

/**
 * The "N live" chip — the agent row's door into the switcher, and the mark that
 * says why the door is there.
 *
 * Exported because it is drawn TWICE on one row and must be the same width both
 * times: once invisibly, inside the row's trailing slot, to reserve the space,
 * and once for real in the button that sits over it. See `AgentListItem`.
 *
 * @param props - How many of the agent's sessions are live.
 */
export function LiveSessionsChip({ count }: { count: number }) {
  return (
    <span className="bg-status-success/15 text-status-success flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold tabular-nums">
      <span className={cn('size-1.5 rounded-full', statusDotClass('working'))} />
      {count} live
    </span>
  );
}
