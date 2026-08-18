import { Clock, Mail, WifiOff } from 'lucide-react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { AttentionItem } from '@/layers/features/dashboard-attention';
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

const ATTENTION: AttentionItem[] = [
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
  {
    id: 'stalled-session',
    type: 'stalled-session',
    icon: Clock,
    title: 'Session "Refactor auth middleware" idle',
    description: 'Session idle for 47 minutes',
    timestamp: minutesFromLoad(-47),
    action: { label: 'Open →', onClick: () => {} },
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

const ATTENTION_OVERFLOWING: AttentionItem[] = Array.from({ length: 8 }, (_, i) => ({
  ...ATTENTION[i % ATTENTION.length]!,
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
 * The pinned triage header, in the four states a real cockpit reaches at
 * different times of a bad afternoon.
 *
 * Drawn from props rather than from the live queues, because the interesting
 * states are the ones you cannot ask for: an approval you have not been sent,
 * an agent that has not gone offline yet, and a read that has not failed.
 */
export function TriageHeaderShowcases() {
  return (
    <PlaygroundSection
      title="Pinned triage header"
      description="What sits above the home feed and stays there while it scrolls — a band of its own between the room's masthead and the conversation, never inside it: the approvals waiting on a decision, and what broke. Nothing waiting and nothing wrong draws no header at all — no border, no 'all clear' card, nothing. Answers happen where the card is; the feed underneath never moves. It is capped at a fraction of the viewport and scrolls inside itself past that, with a fade over whichever edge still has cards behind it — and only while they are really there. On a phone it condenses to one line of counts while the composer holds the caret, because a software keyboard and this header cannot both have the screen."
    >
      <ShowcaseLabel>
        Quiet: zero DOM, not an empty box (the frame below is the demo&rsquo;s)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 w-full rounded-lg border border-dashed p-4">
          <PinnedTriageHeaderView
            asks={[]}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={[]}
          />
          <p className="text-muted-foreground text-xs">Feed starts here.</p>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Waiting on you</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={[]}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Needs attention</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={ATTENTION}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Both, plus the presence slot</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
            asks={[]}
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={ATTENTION}
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
            approvals={APPROVALS_OVERFLOWING}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={ATTENTION_OVERFLOWING}
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
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={ATTENTION}
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
            approvals={[]}
            approvalsUnavailable
            onRetryApprovals={() => {}}
            attentionItems={[]}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
