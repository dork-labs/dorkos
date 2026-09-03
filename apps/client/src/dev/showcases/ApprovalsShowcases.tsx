import type { PendingApproval, StandingPermission } from '@dorkos/shared/approval-schemas';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  ApprovalList,
  ApprovalsUnavailable,
  StandingPermissionList,
} from '@/layers/features/approvals';

/**
 * The content width of the header marker's popover: 30rem panel less its 16px
 * padding either side and the scroll gutter. The number matters because the card
 * inside it still switches to a horizontal row at the 640px VIEWPORT breakpoint,
 * so on a desktop screen it lays out wide inside a narrow column.
 */
const POPOVER_CONTENT_PX = 424;

/** Roughly what the home tab's triage header gets on a normal window. */
const DASHBOARD_CONTENT_PX = 848;

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and a showcase whose countdowns shift on every
 * re-render is harder to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO expiry `minutes` out from page load. */
function expiresIn(minutes: number): string {
  return new Date(LOADED_AT + minutes * 60_000).toISOString();
}

/** An approval to draw, overriding only what a showcase varies. */
function sample(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary:
      'DorkBot wants to run "Uninstall a marketplace package" with name: sentry-monitor, purge: yes',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: new Date(LOADED_AT).toISOString(),
    expiresAt: expiresIn(105),
    ...overrides,
  };
}

/** The live permissions to draw, including a pair that share a folder name. */
const PERMISSIONS: StandingPermission[] = [
  {
    grantId: '01JZ00000000000000000000G1',
    agentPath: '/Users/dev/agents/dorkbot',
    agentLabel: 'dorkbot',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    expiresAt: expiresIn(212),
  },
  // Two agents whose folders are both called "helper". `--path` is required when
  // an agent is created and nothing uniques its NAME, so this is allowed and the
  // list has to tell them apart or a person cannot act on it.
  {
    grantId: '01JZ00000000000000000000G2',
    agentPath: '/Users/dev/work/acme/helper',
    agentLabel: 'helper',
    capabilityId: 'tasks_delete',
    capabilityTitle: 'Delete a scheduled task',
    expiresAt: expiresIn(38),
  },
  {
    grantId: '01JZ00000000000000000000G3',
    agentPath: '/Users/dev/work/beta/helper',
    agentLabel: 'helper',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    expiresAt: expiresIn(0.4),
  },
];

/** A queue long enough to trip the six-card cap. */
const QUEUE: PendingApproval[] = Array.from({ length: 8 }, (_, i) =>
  sample({
    approvalId: `01JZ000000000000000000000${i}`,
    capabilityTitle: i % 2 === 0 ? 'Uninstall a marketplace package' : 'Delete a workspace',
    summary:
      i % 2 === 0
        ? `DorkBot wants to run "Uninstall a marketplace package" with name: package-${i}, purge: no`
        : `An unidentified caller wants to run "Delete a workspace" with path: /tmp/scratch-${i}`,
    ...(i % 3 === 0 ? {} : { requestedBy: `/Users/dev/agents/agent-${i}` }),
    expiresAt: expiresIn((i + 1) * 12),
  })
);

/** A fixed-width column labelled with the surface it stands in for. */
function WidthColumn({
  px,
  caption,
  children,
}: {
  px: number;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-3xs mb-2 tracking-wide uppercase">
        {caption} ({px}px)
      </p>
      <div className="border-border/60 rounded-lg border border-dashed p-2" style={{ width: px }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The capability-approval card: one thing an agent wants to do, and the two
 * buttons that answer it. Nothing is pre-selected and neither button is styled
 * as the safe default.
 *
 * Its own export because the Conversation page's Asks section cross-lists it
 * (the `maintaining-dev-playground` skill's borrow pattern) — a different
 * question from the Ask card family (may this agent do X at all, not answer
 * this one interaction), still worth seeing beside the rest of the family.
 * Its registry entry stays on Subsystems, where this page renders it.
 */
export function ApprovalCardShowcase() {
  return (
    <PlaygroundSection
      title="ApprovalCard"
      description="One thing an agent wants to do, and the two buttons that answer it. Nothing is pre-selected and neither button is styled as the safe default."
    >
      <ShowcaseLabel>The same card at both decision widths</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-start gap-6">
          <WidthColumn px={POPOVER_CONTENT_PX} caption="Header popover">
            <ApprovalList approvals={[sample()]} />
          </WidthColumn>
          <WidthColumn px={DASHBOARD_CONTENT_PX} caption="Dashboard section">
            <ApprovalList approvals={[sample()]} />
          </WidthColumn>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Tiers</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sample({ tier: 'destructive' }),
            sample({
              approvalId: '01JZ0000000000000000000011',
              tier: 'act',
              capabilityTitle: 'Create an agent',
              summary: 'DorkBot wants to run "Create an agent" with name: release-bot',
            }),
            sample({
              approvalId: '01JZ0000000000000000000012',
              tier: 'observe',
              capabilityTitle: 'List your agents',
              summary: 'DorkBot wants to run "List your agents"',
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Who asked, and how long is left</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sample({ approvalId: '01JZ0000000000000000000021', requestedBy: 'DorkBot' }),
            sample({
              approvalId: '01JZ0000000000000000000022',
              requestedBy: undefined,
              // No agent path either, which is what makes this card ineligible to
              // become a standing permission. The two travel together on a real
              // anonymous request, and a showcase that split them would teach the
              // wrong thing to whoever draws the third button off it.
              hasAgentPath: false,
              summary: 'An unidentified caller wants to run "Uninstall a marketplace package"',
            }),
            // Inside the last minute, where the countdown reads "expiring".
            sample({
              approvalId: '01JZ0000000000000000000023',
              expiresAt: expiresIn(0.6),
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>A summary at the 500-character cap</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sample({
              approvalId: '01JZ0000000000000000000031',
              summary: `DorkBot wants to run "Uninstall a marketplace package" with ${'name: a-very-long-package-name, '.repeat(14)}purge: yes`,
            }),
          ]}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Action-approval showcases: the card, the queue, and the two widths those have
 * to survive.
 *
 * Exists because the decision surface moved. Approvals used to appear only in a
 * full-width page section; they now also open in a ~424px popover from the
 * app header, which is the primary place a person answers them. Rendering both
 * widths side by side is the cheapest way to see whether a destructive-tier card
 * still reads at the narrow one, with no dev server and no agent asking for
 * anything.
 *
 * The header marker itself lives in the Inbox showcase next door — the wired
 * `InboxBell` subscribes to the live `/api/events` stream, which the playground
 * does not mount, so what is drawn there is its presentational pill in each of
 * its states rather than a replica that could drift from it.
 */
export function ApprovalsShowcases() {
  return (
    <>
      <ApprovalCardShowcase />

      <PlaygroundSection
        title="ApprovalList"
        description="The shared card stack behind both surfaces. Caps at six cards and says how many the cap is holding back, because a silently hidden request is an agent blocked with nothing on screen to suggest it exists."
      >
        <ShowcaseLabel>A queue past the cap</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-start gap-6">
            <WidthColumn px={POPOVER_CONTENT_PX} caption="Header popover">
              <ApprovalList approvals={QUEUE} />
            </WidthColumn>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="StandingPermissionList"
        description="Trust that is already live, and the button that ends it. Drawn in both places a person can find one — the header panel and Settings under Security — so what a permission looks like cannot differ between where you stumble on it and where you go looking."
      >
        <ShowcaseLabel>The same list at both widths it has to survive</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-start gap-6">
            <WidthColumn px={POPOVER_CONTENT_PX} caption="Header popover">
              <StandingPermissionList permissions={PERMISSIONS} />
            </WidthColumn>
            <WidthColumn px={DASHBOARD_CONTENT_PX} caption="Settings dialog">
              <StandingPermissionList permissions={PERMISSIONS} />
            </WidthColumn>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>At phone width, where the button must not shrink</ShowcaseLabel>
        <ShowcaseDemo>
          <WidthColumn px={288} caption="Bottom sheet">
            <StandingPermissionList permissions={PERMISSIONS} />
          </WidthColumn>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ApprovalsUnavailable"
        description="The state that must never look like silence. A failed read and 'nothing is waiting' are the same empty space on screen, and the difference is an agent sitting blocked while nobody knows to answer it."
      >
        <ShowcaseLabel>Could not read the list</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <ApprovalsUnavailable onRetry={() => {}} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
