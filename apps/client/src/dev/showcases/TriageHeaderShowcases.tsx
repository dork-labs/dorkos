import { Mail, WifiOff } from 'lucide-react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { Task } from '@dorkos/shared/types';
import type { AttentionSignal } from '@/layers/entities/attention';
import type { RecentActivityItem } from '@/layers/features/dashboard-attention';
import { PinnedTriageHeaderView } from '@/layers/widgets/home';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and countdowns that shift on every re-render
 * are harder to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` either side of page load. */
function minutesFromLoad(minutes: number): string {
  return new Date(LOADED_AT + minutes * 60_000).toISOString();
}

const APPROVALS: PendingApproval[] = [
  {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary:
      'DorkBot wants to run "Uninstall a marketplace package" with name: sentry-monitor, purge: yes',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: minutesFromLoad(-3),
    expiresAt: minutesFromLoad(105),
  },
  {
    approvalId: '01JZ0000000000000000000002',
    capabilityId: 'workspace.delete',
    capabilityTitle: 'Delete a workspace',
    tier: 'act',
    summary: 'tangerines wants to run "Delete a workspace" with path: /tmp/scratch-4',
    requestedBy: '/Users/dev/agents/tangerines',
    hasAgentPath: true,
    requestedAt: minutesFromLoad(-11),
    expiresAt: minutesFromLoad(42),
  },
];

/** A schedule an agent proposed. It parks until somebody says yes or no. */
const SCHEDULES: Task[] = [
  {
    id: 'task-standup',
    name: 'morning-standup',
    displayName: 'Morning standup digest',
    description: null,
    prompt: 'Summarise what the fleet did overnight.',
    cron: '0 9 * * 1-5',
    timezone: 'America/Chicago',
    agentId: '/Users/dev/agents/dorkbot',
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: '/Users/dev/agents/dorkbot/.dork/tasks/morning-standup/SKILL.md',
    createdAt: minutesFromLoad(-26),
    updatedAt: minutesFromLoad(-26),
  },
];

/** A session that stopped, straight from the one attention engine. */
const ERRORS: AttentionSignal[] = [
  {
    id: 'error:ses-9',
    kind: 'error',
    primary: 'tangerines',
    secondary: 'Stopped with an error',
    since: minutesFromLoad(-8),
    deepLink: '/session?session=ses-9',
    dismissible: false,
    agentPath: '/Users/dev/agents/tangerines',
  },
];

/** What went wrong lately. Nothing here is waiting on anybody. */
const ACTIVITY: RecentActivityItem[] = [
  {
    id: 'offline-agents',
    type: 'offline-agent',
    icon: WifiOff,
    title: '2 agents offline',
    description: '2 mesh agents unreachable',
    timestamp: minutesFromLoad(0),
    action: { label: 'View →', onClick: () => {} },
    severity: 'error',
  },
  {
    id: 'dead-letter-relay-unroutable',
    type: 'dead-letter',
    icon: Mail,
    title: '6 undeliverable Relay messages',
    description: 'Dead letters: relay — no route to agent',
    timestamp: minutesFromLoad(-18),
    action: { label: 'View →', onClick: () => {} },
    severity: 'warning',
  },
];

/**
 * More than the header is allowed to be tall, so the scroll cue is on screen.
 *
 * The height cap is a viewport fraction, so the only way to make a demo overflow
 * is to give it more than a screen of cards — six approvals and eight rows is
 * the load the cap was written for, and a bad afternoon reaches it.
 */
const APPROVALS_OVERFLOWING: PendingApproval[] = Array.from({ length: 6 }, (_, i) => ({
  ...APPROVALS[i % APPROVALS.length]!,
  approvalId: `01JZ00000000000000000001${i}`,
  requestedAt: minutesFromLoad(-2 - i * 4),
  expiresAt: minutesFromLoad(90 - i * 7),
}));

const ACTIVITY_OVERFLOWING: RecentActivityItem[] = Array.from({ length: 8 }, (_, i) => ({
  ...ACTIVITY[i % ACTIVITY.length]!,
  id: `overflow-${i}`,
  timestamp: minutesFromLoad(-3 - i * 6),
}));

/**
 * The strip task 2.4 fills, stood in for so the seam is visible: anything in the
 * slot keeps the header on screen by itself, which is what lets an idle cockpit
 * still say who is working.
 */
function PresenceSlotStandIn() {
  return (
    <p className="text-muted-foreground border-border/60 border-t pt-2 text-xs">
      Presence strip slot — filled by the strip, empty here.
    </p>
  );
}

/**
 * The pinned triage header, in the states a real cockpit reaches at different
 * times of a bad afternoon.
 *
 * Drawn from props rather than from the live queues, because the interesting
 * states are the ones you cannot ask for: an approval you have not been sent,
 * an agent that has not gone offline yet, and a read that has not failed.
 */
export function TriageHeaderShowcases() {
  return (
    <PlaygroundSection
      title="Pinned triage header"
      description="What sits above the home feed and stays there while it scrolls — a band of its own between the room's masthead and the conversation, never inside it: what is waiting on a decision, what needs you, and what went wrong lately. Nothing waiting and nothing wrong draws no header at all — no border, no 'all clear' card, nothing. Answers happen where the card is; the feed underneath never moves. It is capped at a fraction of the viewport and scrolls inside itself past that, with a fade over whichever edge still has cards behind it — and only while they are really there. On a phone it condenses to one line of counts while the composer holds the caret, because a software keyboard and this header cannot both have the screen."
    >
      <ShowcaseLabel>
        Quiet: zero DOM, not an empty box (the frame below is the demo&rsquo;s)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 w-full rounded-lg border border-dashed p-4">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={[]}
          />
          <p className="text-muted-foreground text-xs">Feed starts here.</p>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Waiting on you</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={[]}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Needs attention: a proposed schedule and a session that stopped</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={SCHEDULES}
            errorSignals={ERRORS}
            activityItems={[]}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Recent activity: nothing is waiting, something went wrong</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={ACTIVITY}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>All three, plus the presence slot</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={SCHEDULES}
            errorSignals={ERRORS}
            activityItems={ACTIVITY}
            presence={{ occupied: true, node: <PresenceSlotStandIn /> }}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        More than fits: the fade over the edge that still has cards behind it (scroll it)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={APPROVALS_OVERFLOWING}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={ACTIVITY_OVERFLOWING}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Condensed: what a phone shows while the keyboard is up (tap to re-expand)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={SCHEDULES}
            errorSignals={ERRORS}
            activityItems={ACTIVITY}
            condensed
            onExpand={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Unreadable: the one state that must never look like &ldquo;nothing is waiting&rdquo;
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={[]}
            approvalsUnavailable
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={[]}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
