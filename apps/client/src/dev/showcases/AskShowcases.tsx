/**
 * The Ask card family: three kinds, a burst, a countdown and five endings.
 *
 * One card is drawn on five surfaces, so a regression in it is a regression
 * everywhere at once — and four of those surfaces only appear when an agent
 * happens to be parked on something, which is not a state anybody can browse to.
 * Drawn here, the whole family is one glance.
 *
 * **These are the REAL components.** Every card below is `InteractionAsk` or
 * `AskStack` over a fixture `InteractionPendingEvent`, so a recreation cannot
 * drift from what a person actually answers. The one thing pinned rather than
 * live is the clock: `startedAt` is measured against a frozen `NOW`, because a
 * showcase whose countdown ticks against the wall clock flaps every time the
 * page is opened.
 *
 * @module dev/showcases/AskShowcases
 */
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import type { AskReceipt } from '@/layers/entities/attention';
import { AskCard, AskList, AskReceiptLine, AskStack, InteractionAsk } from '@/layers/features/ask';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * The instant every fixture below is measured against.
 *
 * FROZEN, like the lane's own fixtures: with a live `Date.now()` the urgent
 * demo reads "expired" forty-five seconds after the page is opened, and a
 * showcase that cannot show what it claims is worse than none.
 */
const NOW = Date.parse('2026-08-18T10:00:00.000Z');

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
function AskKindsShowcase() {
  return (
    <PlaygroundSection
      title="Ask card"
      description="One prompt an agent is parked on, drawn the same way on every surface it appears."
    >
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
    </PlaygroundSection>
  );
}

/** The countdown's three bands. */
function AskCountdownShowcase() {
  return (
    <PlaygroundSection
      title="Ask countdown"
      description="Neutral above two minutes, amber at two, red at one. The bar is decoration and says so; the words are the accessible reading."
    >
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
    </PlaygroundSection>
  );
}

/** Bursts: what stacks, and what deliberately does not. */
function AskStackShowcase() {
  const reads = Array.from({ length: 5 }, (_, index) => ({
    id: `read-${index}`,
    line: `wants to read notes/${index}.md`,
  }));
  return (
    <PlaygroundSection
      title="Ask burst"
      description="Five reads from one agent are one decision. Two agents are two, and always will be."
    >
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
    </PlaygroundSection>
  );
}

/** Every ending a prompt can have, in the words the card says it. */
function AskReceiptLineShowcase() {
  const receipts: Array<[string, AskReceipt]> = [
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
      'Somebody else answered, and the server named them',
      {
        outcome: 'answered',
        resolvedAt: '2026-08-18T14:01:00.000Z',
        resolvedBy: 'Dorian',
        byThisWindow: false,
      },
    ],
    [
      'Somebody else answered, and nobody can say who',
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
    <PlaygroundSection
      title="Ask receipts"
      description="Every way a prompt can end says so. A card never simply disappears, and never leaves a button that does nothing."
    >
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
    </PlaygroundSection>
  );
}

/** The tray body, including the state it spends most of its life in. */
function AskListShowcase() {
  return (
    <PlaygroundSection
      title="Ask tray"
      description="What the header pill and the home triage header both draw. Sorted by time left, soonest first."
    >
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
    </PlaygroundSection>
  );
}

/** Every Ask surface worth seeing at once. */
export function AskShowcases() {
  return (
    <>
      <AskKindsShowcase />
      <AskCountdownShowcase />
      <AskStackShowcase />
      <AskReceiptLineShowcase />
      <AskListShowcase />
    </>
  );
}
