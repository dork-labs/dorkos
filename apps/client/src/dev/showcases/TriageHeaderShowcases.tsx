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
      description="What sits above the home feed and stays there while it scrolls — a band of its own between the room's masthead and the conversation, never inside it: the approvals waiting on a decision, and what broke. Nothing waiting and nothing wrong draws no header at all — no border, no 'all clear' card, nothing. Answers happen where the card is; the feed underneath never moves."
    >
      <ShowcaseLabel>
        Quiet: zero DOM, not an empty box (the frame below is the demo&rsquo;s)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 w-full rounded-lg border border-dashed p-4">
          <PinnedTriageHeaderView
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
            approvals={APPROVALS}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            attentionItems={ATTENTION}
            presence={{ occupied: true, node: <PresenceSlotStandIn /> }}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Unreadable: the one state that must never look like &ldquo;nothing is waiting&rdquo;
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <PinnedTriageHeaderView
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
