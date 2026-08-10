/**
 * The honesty ladder and the avatar signal system, as the sidebar draws them.
 *
 * Every row here is the real `SidebarRow` fed by the real `SessionVerbLine`
 * reading the real session-list store — nothing is a mock-up of a row. That is
 * the point of the page: the four rungs are only trustworthy if the thing on
 * screen is the thing that ships, and a replica would agree with itself
 * forever while the product drifted underneath it.
 *
 * @module dev/showcases/VerbLadderShowcases
 */
import { useEffect, type ReactNode } from 'react';
import type { SessionActivity, SessionLifecycle } from '@dorkos/shared/session-stream';
import { SessionVerbLine, useSessionListStore } from '@/layers/entities/session';
import { isWelcomeBackMoment } from '@/layers/shared/lib';
import { AgentAvatar } from '@/layers/entities/agent';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarRow,
  STATUS_DOT_LABEL,
  type IdentityStatus,
} from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** One rung of the ladder, as a row the store can actually drive. */
interface Rung {
  /** Store key for this demo session. */
  sessionId: string;
  /** What the row is called. */
  title: string;
  /** The phase the row's session is in. */
  lifecycle: SessionLifecycle;
  /** The tool reading the server has for it, if any. */
  activity?: SessionActivity;
  /** The dot the avatar wears. */
  status: IdentityStatus;
  /** Which rung this is, in words, for the label beside it. */
  rung: string;
}

/**
 * A fixed clock for the welcome-back demo, so the showcase does not re-decide
 * its own story on every render.
 */
const DEMO_NOW = 1_800_000_000_000;

/** The four rungs, top to bottom: specific verb, working…, waiting on you, silence. */
const RUNGS: readonly Rung[] = [
  {
    sessionId: 'dev-verb-specific',
    title: 'the flaky room test',
    lifecycle: 'streaming',
    activity: { toolName: 'Edit', target: 'RoomRow.tsx' },
    status: 'working',
    rung: '1 · a tool it can name, with what the tool is pointed at',
  },
  {
    sessionId: 'dev-verb-generic',
    title: 'the codex port',
    lifecycle: 'streaming',
    status: 'working',
    rung: '2 · a live turn whose tool it does not know — all it can honestly say',
  },
  {
    sessionId: 'dev-verb-blocked',
    title: 'the release notes',
    lifecycle: 'blocked',
    activity: { toolName: 'Bash', target: 'pnpm release' },
    status: 'needs-you',
    rung: '3 · blocked. The only rung that is about YOU, so it outranks the tool',
  },
  {
    sessionId: 'dev-verb-idle',
    title: 'yesterday’s refactor',
    lifecycle: 'idle',
    status: 'idle',
    rung: '4 · nothing. A verb that outlives its turn is a lie',
  },
];

/** The three signals that draw a dot, for the both-themes pair. */
const SIGNAL_ROWS: readonly Rung[] = [
  RUNGS[0],
  RUNGS[2],
  {
    sessionId: 'dev-verb-error',
    title: 'the migration',
    lifecycle: 'error',
    status: 'error',
    rung: 'error',
  },
];

/** Push every demo session's status into the store the rows read from. */
function useSeededLadder(): void {
  useEffect(() => {
    for (const rung of [...RUNGS, ...SIGNAL_ROWS]) {
      useSessionListStore.getState().applyListEvent({
        type: 'session_status',
        sessionId: rung.sessionId,
        status: {
          contextUsage: null,
          cost: null,
          usage: null,
          cacheStats: null,
          model: null,
          permissionMode: 'default',
          todoCounts: null,
          runningSubagentCount: 0,
          lifecycle: rung.lifecycle,
          lastError: null,
          activity: rung.activity,
        },
      });
    }
  }, []);
}

/** One ladder row, in the sidebar's own markup context. */
function LadderRow({ rung, welcomeBack = false }: { rung: Rung; welcomeBack?: boolean }) {
  return (
    <SidebarRow
      glyph={<AgentAvatar color="#6366f1" emoji="🔍" size="xs" status={rung.status} />}
      who="Scout"
      title={rung.title}
      welcomeBack={welcomeBack}
      // Lifecycle decides the HEIGHT; the leaf inside decides the WORDS. A row
      // that is neither streaming nor blocked keeps one line, whatever the
      // store still remembers about it.
      reservesVerbLine={rung.lifecycle === 'streaming' || rung.lifecycle === 'blocked'}
      secondLine={<SessionVerbLine sessionId={rung.sessionId} lifecycle={rung.lifecycle} />}
      onSelect={() => {}}
    />
  );
}

/** A 272px sidebar panel, so the rows are reviewed at the width they ship at. */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-sidebar text-sidebar-foreground w-[272px] rounded-lg ${className ?? ''}`}>
      <SidebarGroup>
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarGroup>
    </div>
  );
}

/** The verb ladder and the avatar signal system, in one reviewable place. */
export function VerbLadderShowcases() {
  useSeededLadder();

  return (
    <PlaygroundSection
      title="Verb ladder & signals"
      description="What a row is allowed to say a session is doing, and the corner dot that says it without words. One function feeds the sidebar, the session switcher and the chat status strip — degrade down the ladder, never guess."
    >
      <ShowcaseLabel>The four rungs, driven by the real store</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-4">
          {RUNGS.map((rung) => (
            <div key={rung.sessionId} className="space-y-1">
              <p className="text-muted-foreground text-[11px]">{rung.rung}</p>
              <Panel>
                <LadderRow rung={rung} />
              </Panel>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Both themes, side by side — working, needs-you and error together (R1)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-4">
          {(['light', 'dark'] as const).map((theme) => (
            <div key={theme} className={theme}>
              <p className="text-muted-foreground mb-1 text-[11px]">{theme}</p>
              <Panel>
                {SIGNAL_ROWS.map((rung) => (
                  <LadderRow key={rung.sessionId} rung={rung} />
                ))}
              </Panel>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Colour is never the sole indicator (R2) — what each dot says in words
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ul className="text-muted-foreground space-y-1 text-xs">
          {SIGNAL_ROWS.map((rung) => (
            <li key={rung.sessionId}>
              <span className="text-foreground font-medium">{rung.status}</span> — announced as “
              {rung.status === 'idle' ? '' : STATUS_DOT_LABEL[rung.status]}”, and paired on the row
              with a verb line or, for a wedged session, with its Now item.
            </li>
          ))}
        </ul>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Welcome back — the one beat a row plays for work that finished while you were away (BC-49)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-1">
          <p className="text-muted-foreground text-[11px]">
            Amber, once, on first paint, and never again — a re-render cannot re-arm it. Nothing
            renders at all under a reduced-motion preference.
          </p>
          <Panel>
            {/* Through the real rule, not a hardcoded `true`: this row's work
                finished two hours into a four-hour absence, and the threshold
                is the one the user's own welcome-back setting carries. */}
            <LadderRow
              rung={RUNGS[3]}
              welcomeBack={isWelcomeBackMoment({
                finishedAt: DEMO_NOW - 120 * 60_000,
                lastSeenAt: DEMO_NOW - 240 * 60_000,
                absenceThresholdMinutes: 240,
                now: DEMO_NOW,
              })}
            />
          </Panel>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
