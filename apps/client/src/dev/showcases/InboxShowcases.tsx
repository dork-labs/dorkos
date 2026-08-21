/**
 * The Inbox, drawn without a server: the bell in each of its states, and the
 * rows the panel behind it holds.
 *
 * The wired `InboxBell` is deliberately absent — it subscribes to the live
 * `/api/events` stream and four queries, which the playground does not mount.
 * What is here is the same presentational pill it renders and the same
 * `InboxRow` its list renders, so these cannot drift into a replica.
 *
 * @module dev/showcases/InboxShowcases
 */
import { useCallback, useState } from 'react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { InboxRow, InboxGroupRow, groupActivityRows, groupStateKey } from '@/layers/features/inbox';
import type { AgentVisualSource } from '@/layers/entities/agent';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { InboxBellPill } from '@/layers/widgets/inbox-bell';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and times that shift on every re-render are
 * harder to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` before page load. */
function minutesAgo(minutes: number): string {
  return new Date(LOADED_AT - minutes * 60_000).toISOString();
}

/** One row of each tier, read and unread, across the kinds that ship wired. */
const ROWS: NotificationDTO[] = [
  {
    id: '01JZB0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-9' },
    sessionId: 'ses-9',
    agentId: 'tangerines',
    title: 'meeting-notes finished',
    createdAt: minutesAgo(2),
  },
  {
    id: '01JZB0000000000000000002',
    kind: 'run.completed',
    tier: 'notable',
    subject: { type: 'run', id: 'run-4412' },
    agentId: 'dorkbot',
    title: 'Nightly sweep failed',
    body: 'Failed after 2m 14s. Exit code 1.',
    createdAt: minutesAgo(46),
  },
  {
    id: '01JZB0000000000000000003',
    kind: 'agent.note',
    tier: 'notable',
    subject: { type: 'agent', id: 'dorkbot' },
    agentId: 'dorkbot',
    sessionId: 'ses-3',
    title: 'DorkBot has a note for you',
    body: 'The migration is staged and waiting for your review.',
    createdAt: minutesAgo(95),
    readAt: minutesAgo(90),
  },
  {
    id: '01JZB0000000000000000004',
    kind: 'agent.unreachable',
    tier: 'quiet',
    subject: { type: 'agent', id: 'tangerines' },
    agentId: 'tangerines',
    title: 'tangerines stopped answering',
    createdAt: minutesAgo(180),
    readAt: minutesAgo(170),
  },
  {
    id: '01JZB0000000000000000005',
    kind: 'update.installed',
    tier: 'quiet',
    subject: { type: 'system', id: '0.61.0' },
    title: 'DorkOS updated to 0.61.0',
    body: 'You were on 0.60.2.',
    createdAt: minutesAgo(1_400),
    readAt: minutesAgo(1_390),
  },
  {
    id: '01JZB0000000000000000006',
    kind: 'dm.received',
    tier: 'notable',
    subject: { type: 'room', id: 'room-1' },
    agentId: 'shadow-fox',
    title: 'shadow-fox messaged you',
    body: 'Can you take a look at the deploy?',
    createdAt: minutesAgo(6),
  },
];

/**
 * The roster this showcase pretends to hold, keyed by the `agentId`s above.
 *
 * `dorkbot` and `tangerines` resolve; `shadow-fox` deliberately does not —
 * the third row's own point is the fallback, so leaving it out of this map
 * IS the fixture. Carries `name` too, not just the face fields
 * `AgentVisualSource` needs, so {@link getAgentDisplayName} — the same
 * resolver `InboxList` calls on the real roster — has something to read.
 */
const AGENTS: Record<string, AgentVisualSource & { name: string }> = {
  dorkbot: { id: 'dorkbot', color: '#f97316', icon: '🤖', name: 'DorkBot' },
  tangerines: { id: 'tangerines', color: '#f59e0b', icon: '🍊', name: 'tangerines' },
};

/**
 * Resolve a face the same way `InboxList` resolves one off the real roster:
 * `undefined` for "no id to look up", `null` for "looked, not found" — never
 * `''` standing in for a miss, which would key `AGENTS['']` instead of
 * naming the miss explicitly (review round 1).
 *
 * @param agentId - The notification's own `agentId`, if it has one.
 */
function resolveShowcaseAgent(agentId: string | undefined) {
  return agentId === undefined ? undefined : (AGENTS[agentId] ?? null);
}

/** Three of DorkBot's runs in a row — long enough to collapse. */
const BURST_ROWS: NotificationDTO[] = [
  {
    id: '01JZB0000000000000000010',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-1' },
    agentId: 'dorkbot',
    title: 'Nightly sweep finished',
    createdAt: minutesAgo(5),
  },
  {
    id: '01JZB0000000000000000011',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-2' },
    agentId: 'dorkbot',
    title: 'Nightly sweep finished',
    createdAt: minutesAgo(65),
  },
  {
    id: '01JZB0000000000000000012',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-3' },
    agentId: 'dorkbot',
    title: 'Nightly sweep finished',
    createdAt: minutesAgo(125),
    readAt: minutesAgo(120),
  },
];

/** Two of the same run — one short of the threshold, so it stays flat. */
const PAIR_ROWS: NotificationDTO[] = [
  {
    id: '01JZB0000000000000000020',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-4' },
    agentId: 'tangerines',
    title: 'Weekly digest finished',
    createdAt: minutesAgo(8),
  },
  {
    id: '01JZB0000000000000000021',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-5' },
    agentId: 'tangerines',
    title: 'Weekly digest finished',
    createdAt: minutesAgo(70),
  },
];

/** The five states the pill can be in, plus the sixth that draws nothing. */
function BellStatesShowcase() {
  return (
    <PlaygroundSection
      title="Inbox bell"
      description="The header marker in each state. Amber means exactly one thing — something is stopped and waiting on you. Everything else is neutral, because spending the alarm on news that is not urgent is how a marker stops being read."
    >
      <ShowcaseLabel>Quiet: nothing waiting, nothing unread</ShowcaseLabel>
      <ShowcaseDemo>
        {/* The real bell renders no element at all here. The dashed box stands
            in for the space it does not take, because "nothing" and "the demo
            failed to load" look identical otherwise. */}
        <div className="border-border/60 text-muted-foreground rounded-md border border-dashed px-3 py-1.5 text-xs">
          nothing rendered
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Blocking: agents are waiting on an answer</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="waiting"
          glyph="waiting"
          count={3}
          text="waiting on you"
          label="3 things are waiting on you. Open to answer them."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Settling: the last one was just answered</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="waiting"
          glyph="waiting"
          text="answered"
          label="Your answer was recorded."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Unread only: nothing is blocked, things happened</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="neutral"
          glyph="unread"
          count={12}
          text="unread"
          label="12 unread notifications. Open your Inbox."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Over the cap: a long queue reads &ldquo;9+&rdquo;</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="waiting"
          glyph="waiting"
          count={24}
          text="waiting on you"
          label="24 things are waiting on you. Open to answer them."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Standing permissions are live, and nothing else is true</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="neutral"
          glyph="trusted"
          count={2}
          text="trusted"
          label="2 standing permissions are live. Open to see them or end them."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>A read that failed — never silence</ShowcaseLabel>
      <ShowcaseDemo>
        <InboxBellPill
          tone="waiting"
          glyph="waiting"
          text="can't check approvals"
          label="DorkOS could not check for approvals. Open for details."
        />
        <InboxBellPill
          tone="neutral"
          glyph="untrusted"
          text="can't check permissions"
          label="DorkOS could not check which standing permissions are live. Open for details."
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The rows behind the bell, at the width the popover gives them.
 *
 * The two grouped demos below own a real `expanded` Set, exactly the shape
 * `InboxList` keeps — `InboxGroupRow` no longer has state of its own to
 * fake this with, so clicking a header here genuinely expands it rather than
 * standing frozen.
 */
function InboxRowsShowcase() {
  const burstItems = groupActivityRows(BURST_ROWS);
  const pairItems = groupActivityRows(PAIR_ROWS);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <PlaygroundSection
      title="Inbox rows"
      description="What happened, newest first. Unread carries a dot rather than a colour — the row's own tone already says how loud the event was, and two scales fighting for one line is how neither gets read."
    >
      <ShowcaseLabel>
        A mixed page: faces where an agent resolved, the kind glyph where one did not (shadow-fox)
        or where the tone is loud enough to keep it (the failed run)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
          {ROWS.map((row) => (
            <InboxRow
              key={row.id}
              notification={row}
              agent={resolveShowcaseAgent(row.agentId)}
              onOpen={() => {}}
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A burst of three, collapsed — click to expand; expanding never marks anything read
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
          {burstItems.map((item) =>
            item.type === 'group' ? (
              <InboxGroupRow
                key={item.id}
                group={item}
                agent={resolveShowcaseAgent(item.agentId)}
                agentName={getAgentDisplayName(AGENTS[item.agentId])}
                expanded={expandedGroups.has(groupStateKey(item.agentId, item.kind, item.tone))}
                onToggleExpanded={() =>
                  toggleGroup(groupStateKey(item.agentId, item.kind, item.tone))
                }
                onOpenNotification={() => {}}
              />
            ) : (
              <InboxRow
                key={item.notification.id}
                notification={item.notification}
                agent={resolveShowcaseAgent(item.notification.agentId)}
                onOpen={() => {}}
              />
            )
          )}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Two in a row stays flat — the coalescing threshold is three</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
          {pairItems.map((item) =>
            item.type === 'group' ? (
              <InboxGroupRow
                key={item.id}
                group={item}
                agent={resolveShowcaseAgent(item.agentId)}
                agentName={getAgentDisplayName(AGENTS[item.agentId])}
                expanded={expandedGroups.has(groupStateKey(item.agentId, item.kind, item.tone))}
                onToggleExpanded={() =>
                  toggleGroup(groupStateKey(item.agentId, item.kind, item.tone))
                }
                onOpenNotification={() => {}}
              />
            ) : (
              <InboxRow
                key={item.notification.id}
                notification={item.notification}
                agent={resolveShowcaseAgent(item.notification.agentId)}
                onOpen={() => {}}
              />
            )
          )}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing yet</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
          <p className="text-muted-foreground px-2 py-1 text-xs">Nothing yet</p>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Every Inbox showcase, in the order the panel stacks them. */
export function InboxShowcases() {
  return (
    <>
      <BellStatesShowcase />
      <InboxRowsShowcase />
    </>
  );
}
