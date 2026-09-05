/**
 * Asks — the card family every surface draws, in one section.
 *
 * Consolidates what used to be five separate registry entries in
 * `AskShowcases.tsx` (the card's three kinds, its countdown, a burst, five
 * receipt endings and the tray), the inline transcript prompt and its receipt
 * (`ToolShowcases.tsx`'s former "ApprovalPrompt" section and
 * `AskReceiptShowcases.tsx`) (DOR-1332, P5).
 *
 * The capability-approval card is a near relative rather than part of this
 * family — it answers "may this agent do X at all" — and **Home, Inbox &
 * Approvals** owns its entry. `ConversationPage` borrows it by rendering it
 * at page level, the shape `IdentityPage` established for the skill's borrow
 * pattern; it is not nested inside this section.
 *
 * **These are the REAL components.** Every card below is `InteractionAsk`,
 * `AskStack`, `ApprovalPrompt` or `AskReceipt` over fixture data, so a
 * recreation cannot drift from what a person actually answers.
 *
 * @module dev/showcases/AsksShowcases
 */
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import type { AskReceipt as AskReceiptShape } from '@/layers/entities/attention';
import {
  AskCard,
  AskList,
  AskReceipt,
  AskReceiptLine,
  AskStack,
  ApprovalPrompt,
  InteractionAsk,
} from '@/layers/features/ask';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_SESSION_ID, TOOL_CALL_APPROVAL } from '../mock-chat-data';
import { createPlaygroundTransport } from '../playground-transport';

const playgroundTransport = createPlaygroundTransport();

/**
 * The instant every fixture below is measured against — read once, at module
 * load, never per render (`Date.now()` during render is impure,
 * `react-hooks/purity`). Same shape as `TimelineShowcases`' `PENDING_AT`.
 *
 * It has to be a real wall-clock reading rather than a written-out date. The
 * card computes its deadline as `startedAt + timeoutMs` (`InteractionAsk.tsx`),
 * so a date pinned in the source is a deadline permanently in the past: every
 * card reads `expired`, and the three countdown bands this section exists to
 * show are unreachable. Opening the page starts each fixture at the reading its
 * label promises; leaving it open long enough will run the short ones down,
 * which is the honest behaviour of a countdown.
 */
const NOW = Date.now();

/** A subheading inside the one Asks section — not its own registry entry. */
function Subhead({ children }: { children: string }) {
  return <h3 className="text-foreground mt-2 text-sm font-semibold">{children}</h3>;
}

/** One prompt, from an agent in `/projects/meeting-notes`. */
function ask(
  id: string,
  interaction: PendingInteractionDTO,
  overrides: Partial<InteractionPendingEvent> = {}
): InteractionPendingEvent {
  return {
    sessionId: 'session-meeting-notes',
    cwd: '/projects/meeting-notes',
    interaction: { ...interaction, id },
    ...overrides,
  };
}

/** A permission prompt with `secondsLeft` on its clock. */
function approval(
  secondsLeft: number,
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>> = {}
): PendingInteractionDTO {
  return {
    type: 'approval',
    id: 'tc-1',
    startedAt: NOW - (600 - secondsLeft) * 1000,
    remainingMs: secondsLeft * 1000,
    timeoutMs: 600_000,
    toolName: 'Edit',
    input: JSON.stringify({ file_path: '/projects/meeting-notes/standup.md' }),
    displayName: 'Edit standup.md',
    description: 'Add the release checklist to the notes file.',
    blockedPath: 'standup.md',
    hasSuggestions: false,
    ...overrides,
  };
}

/** The three kinds, and the headline each one produces. */
function AskKinds() {
  return (
    <>
      <Subhead>Ask card — three kinds, drawn the same way on every surface</Subhead>
      <ShowcaseLabel>A permission prompt — the prompt named the action</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk ask={ask('demo-1', approval(420))} agentName="Meeting Notes" />
      </ShowcaseDemo>

      <ShowcaseLabel>
        The same prompt with no display name and no path — the card names the tool rather than
        inventing a verb
      </ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk
          ask={ask(
            'demo-2',
            approval(420, {
              toolName: 'Bash',
              input: 'not parseable',
              displayName: undefined,
              description: undefined,
              blockedPath: undefined,
            })
          )}
          agentName="Meeting Notes"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>A question</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk
          ask={ask('demo-3', {
            type: 'question',
            id: 'demo-3',
            startedAt: NOW - 60_000,
            remainingMs: 540_000,
            questions: [
              {
                header: 'Runner',
                question: 'Which test runner should I set up?',
                options: [{ label: 'Vitest' }, { label: 'Jest' }],
                multiSelect: false,
              },
            ],
          })}
          agentName="Meeting Notes"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>An MCP elicitation</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk
          ask={ask('demo-4', {
            type: 'elicitation',
            id: 'demo-4',
            startedAt: NOW - 30_000,
            remainingMs: 570_000,
            serverName: 'linear',
            message: 'Which team should this issue go to?',
          })}
          agentName="Meeting Notes"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>With somewhere to go — the surface supplies “Open session”</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk
          ask={ask('demo-5', approval(420))}
          agentName="Meeting Notes"
          onOpenSession={() => {}}
        />
      </ShowcaseDemo>
    </>
  );
}

/** The countdown's three bands. */
function AskCountdown() {
  return (
    <>
      <Subhead>
        Ask countdown — neutral above two minutes, amber at two, red at one, and calm again once it
        parks. The bar is decoration; the words are the accessible reading.
      </Subhead>
      <ShowcaseLabel>Seven minutes left — neutral</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk ask={ask('demo-neutral', approval(420))} agentName="Meeting Notes" />
      </ShowcaseDemo>

      <ShowcaseLabel>Two minutes left — warning</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk ask={ask('demo-warning', approval(120))} agentName="Meeting Notes" />
      </ShowcaseDemo>

      <ShowcaseLabel>Under a minute — urgent, and counting by the second</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk ask={ask('demo-urgent', approval(45))} agentName="Meeting Notes" />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Nobody answered — the countdown is over, the bar is gone, and the agent is waiting. Both
        answers still work.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <InteractionAsk
          ask={ask(
            'demo-parked',
            approval(0, {
              startedAt: NOW - 11 * 60_000,
              remainingMs: 4 * 60 * 60_000 - 11 * 60_000,
              timeoutMs: undefined,
              parked: true,
            })
          )}
          agentName="Meeting Notes"
        />
      </ShowcaseDemo>
    </>
  );
}

/** Bursts: what stacks, and what deliberately does not. */
function AskBurst() {
  const reads = Array.from({ length: 5 }, (_, index) => ({
    id: `read-${index}`,
    line: `wants to read notes/${index}.md`,
  }));
  return (
    <>
      <Subhead>Ask burst — five reads from one agent are one decision</Subhead>
      <ShowcaseLabel>Five same-tool prompts from one agent — one card, one Allow all</ShowcaseLabel>
      <ShowcaseDemo>
        <AskStack
          items={reads}
          headline="Meeting Notes wants to run 5 things"
          cwd="/projects/meeting-notes"
          onAllowAll={() => {}}
          onDenyAll={() => {}}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Two agents, never stacked — “Allow all” over somebody else’s work is not one answer
      </ShowcaseLabel>
      <ShowcaseDemo>
        <AskList
          asks={[
            ask('two-agents-1', approval(400)),
            ask('two-agents-2', approval(300), {
              sessionId: 'session-mio',
              cwd: '/projects/mio-clicker',
            }),
          ]}
        />
      </ShowcaseDemo>
    </>
  );
}

/** Every ending a prompt can have, in the words the card says it. */
function AskEndings() {
  const receipts: Array<[string, AskReceiptShape]> = [
    [
      'You answered it here',
      {
        outcome: 'answered',
        resolvedAt: '2026-08-18T14:01:00.000Z',
        byThisWindow: true,
        decision: 'allowed',
      },
    ],
    [
      'You refused it here',
      {
        outcome: 'answered',
        resolvedAt: '2026-08-18T14:01:00.000Z',
        byThisWindow: true,
        decision: 'denied',
      },
    ],
    [
      'Answered in another window, and the server named who',
      {
        outcome: 'answered',
        resolvedAt: '2026-08-18T14:01:00.000Z',
        resolvedBy: 'Dorian',
        byThisWindow: false,
      },
    ],
    [
      'Answered in another window, and nobody can say who',
      { outcome: 'answered', resolvedAt: '2026-08-18T14:01:00.000Z', byThisWindow: false },
    ],
    [
      'The session went away',
      { outcome: 'cancelled', resolvedAt: '2026-08-18T14:01:00.000Z', byThisWindow: false },
    ],
    [
      'The clock answered',
      { outcome: 'expired', resolvedAt: '2026-08-18T14:01:00.000Z', byThisWindow: false },
    ],
  ];

  return (
    <>
      <Subhead>
        Ask receipts — every way a prompt can end says so; a card never simply disappears
      </Subhead>
      {receipts.map(([label, receipt]) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <AskCard.Root isResolved>
              <AskCard.Headline className="mb-2">
                Meeting Notes wants to edit standup.md
              </AskCard.Headline>
              <AskReceiptLine receipt={receipt} />
            </AskCard.Root>
          </ShowcaseDemo>
        </div>
      ))}
    </>
  );
}

/** The tray body, including the state it spends most of its life in. */
function AskTray() {
  return (
    <>
      <Subhead>
        Ask tray — what the header pill and the home triage header both draw, soonest first
      </Subhead>
      <ShowcaseLabel>Three prompts from three agents</ShowcaseLabel>
      <ShowcaseDemo>
        <AskList
          asks={[
            ask('tray-1', approval(400)),
            ask('tray-2', approval(90), {
              sessionId: 'session-mio',
              cwd: '/projects/mio-clicker',
            }),
            ask('tray-3', approval(250), {
              sessionId: 'session-dorkbot',
              cwd: '/projects/dorkbot',
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing waiting</ShowcaseLabel>
      <ShowcaseDemo>
        <AskList
          asks={[]}
          emptyState={<p className="text-muted-foreground text-xs">Nothing needs you</p>}
        />
      </ShowcaseDemo>
    </>
  );
}

/** The inline prompt a session's transcript shows at the tool call itself. */
function InlineApprovalPrompt() {
  return (
    <TransportProvider transport={playgroundTransport}>
      <Subhead>
        Inline approval — ApprovalPrompt, the same permission request drawn at its place in a
        session transcript
      </Subhead>
      <ShowcaseLabel>Inactive</ShowcaseLabel>
      <ShowcaseDemo>
        <ApprovalPrompt
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Active (keyboard shortcut target)</ShowcaseLabel>
      <ShowcaseDemo>
        <ApprovalPrompt
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-active'}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
          isActive
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Warning phase (2 min remaining)</ShowcaseLabel>
      <ShowcaseDemo>
        <ApprovalPrompt
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-warning'}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
          timeoutMs={120_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Urgent phase (30s remaining)</ShowcaseLabel>
      <ShowcaseDemo>
        <ApprovalPrompt
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-urgent'}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
          timeoutMs={30_000}
        />
      </ShowcaseDemo>

      {/* The three reaches one button can have. Worth seeing side by side:
          the same click means "until this chat ends" and "every Claude session
          on this machine", and the only thing separating them is this line of
          text (DOR-1462). */}
      <ShowcaseLabel>Always Allow — the three grant scopes</ShowcaseLabel>
      <ShowcaseDemo>
        {(['session', 'project', 'user'] as const).map((scope) => (
          <ApprovalPrompt
            key={scope}
            sessionId={MOCK_SESSION_ID}
            toolCallId={`${TOOL_CALL_APPROVAL.toolCallId}-scope-${scope}`}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
            approvalHasSuggestions
            approvalAlwaysAllowScope={scope}
          />
        ))}
      </ShowcaseDemo>
    </TransportProvider>
  );
}

/**
 * When the showcased inline-receipt requests were asked for. Fixed rather
 * than `Date.now()` so the clock times on the page do not change between
 * visits.
 */
const RECEIPT_ASKED_AT = new Date('2026-07-31T14:32:00Z').getTime();

/** What an answered approval leaves behind in the transcript — quiet by design. */
function TranscriptReceipt() {
  return (
    <>
      <Subhead>
        Transcript receipt — AskReceipt, the one-line record an answered request leaves at its own
        place in the transcript
      </Subhead>
      <ShowcaseLabel>Allowed</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="allowed"
          items={[{ toolCallId: 'r-1', label: 'Run "npm test"' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 8_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Denied</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="denied"
          items={[{ toolCallId: 'r-2', label: 'Run "rm -rf build"' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 21_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Expired (nobody answered — auto-denied after the full timeout)</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="expired"
          items={[{ toolCallId: 'r-3', label: 'Write config.json' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 600_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Batch — one line, items behind the expander</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="allowed"
          items={[
            { toolCallId: 'r-4', label: 'Run "pnpm install"' },
            { toolCallId: 'r-5', label: 'Write vite.config.ts' },
            { toolCallId: 'r-6', label: 'Edit package.json' },
          ]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 12_000}
        />
      </ShowcaseDemo>
    </>
  );
}

/**
 * The whole Ask card family, in one section — every kind, the countdown, a
 * burst, the endings, the tray, the inline transcript prompt and receipt, and
 * the capability-approval card borrowed from Home, Inbox & Approvals.
 */
export function AsksShowcase() {
  return (
    <PlaygroundSection
      title="Asks"
      description="Everything an agent parks the cockpit on, in one place. One prompt draws on five surfaces — the composer's takeover, the Live lane, the header tray, the home triage header, and the session transcript itself — so a regression here is a regression everywhere at once. The capability-approval card at the foot of this page answers a different question (may this agent do X at all) and is cross-listed from Home, Inbox & Approvals rather than duplicated."
    >
      <AskKinds />
      <AskCountdown />
      <AskBurst />
      <AskEndings />
      <AskTray />
      <InlineApprovalPrompt />
      <TranscriptReceipt />
    </PlaygroundSection>
  );
}
