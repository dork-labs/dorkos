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
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { InboxRow } from '@/layers/features/inbox';
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

/** The rows behind the bell, at the width the popover gives them. */
function InboxRowsShowcase() {
  return (
    <PlaygroundSection
      title="Inbox rows"
      description="What happened, newest first. Unread carries a dot rather than a colour — the row's own tone already says how loud the event was, and two scales fighting for one line is how neither gets read."
    >
      <ShowcaseLabel>A mixed page: unread above, read below</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
          {ROWS.map((row) => (
            <InboxRow key={row.id} notification={row} onOpen={() => {}} />
          ))}
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
