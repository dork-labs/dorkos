import type { Task } from '@dorkos/shared/types';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and ages that shift every re-render are harder
 * to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` either side of page load. */
function minutesFromLoad(minutes: number): string {
  return new Date(LOADED_AT + minutes * 60_000).toISOString();
}

/**
 * A proposal carrying everything the server can send.
 *
 * @param overrides - The fields this particular state is about.
 */
function proposal(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-standup',
    name: 'morning-standup',
    displayName: 'Morning standup digest',
    description: null,
    prompt:
      'Read every session that ran overnight and write a short digest of what changed,\n' +
      'what broke, and what is still waiting on a person. Post it to #team.\n' +
      'Keep it under 200 words and link every claim to the session that produced it.',
    cron: '0 9 * * 1-5',
    timezone: 'America/Chicago',
    agentId: '/Users/dev/agents/dorkbot',
    enabled: false,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    status: 'pending_approval',
    filePath: '/Users/dev/agents/dorkbot/.dork/tasks/morning-standup/SKILL.md',
    createdAt: minutesFromLoad(-26),
    updatedAt: minutesFromLoad(-26),
    reason:
      'Nobody reads the overnight runs, so failures sit unseen until Monday. A digest at 9am puts them in front of you while there is still a day to fix them.',
    proposedBySessionId: 'ses-42',
    proposedByAgentPath: '/Users/dev/agents/dorkbot',
    proposedByName: 'DorkBot',
    nextRuns: [minutesFromLoad(180), minutesFromLoad(1620), minutesFromLoad(3060)],
    ...overrides,
  };
}

/**
 * The approval card, in every state a reviewer cannot conjure in the running
 * app.
 *
 * **These are the states you cannot ask for.** A proposal from an agent that has
 * since been renamed away; one made through the sessionless external `/mcp`
 * registration, which stamps no identity at all; a legacy row from before
 * `reason` existed; a cron the server could not read, so there are no first-run
 * times to show. Each of them is a real shape the server can send, each changes
 * what the card is allowed to say, and none of them can be produced on demand by
 * clicking around.
 *
 * The receipt and test-run strips are the other half: both are transient in the
 * product — the receipt melts, the strip settles — so the only way to look at
 * them properly is to hold them still here. They are driven by clicking the real
 * card, not by a prop, because the card owns its own decision state.
 */
export function ScheduleApprovalShowcases() {
  return (
    <PlaygroundSection
      title="Schedule approval card"
      description="An agent that proposes a scheduled run never arms it — it parks until somebody says yes or no. This is where they say so, and the card's whole job is that the answer is informed: who proposed it, why in their own words, the cadence with its timezone, the first few concrete run times, and the exact instructions one disclosure away. Three answers — Approve, Reject (undoable for a few seconds, because the delete is simply not sent yet), and Run it once, which executes the prompt now as a single supervised run so the decision can be made on evidence rather than on faith. Answerable with A and D while focus is inside the card."
    >
      <ShowcaseLabel>
        Everything present: a reason, a named proposer, a session to open, three run times
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard task={proposal()} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        In a narrow panel — the Inbox popover and the Pulse rail are both about this wide
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-[22rem]">
          <ScheduleApprovalCard task={proposal({ id: 'task-narrow' })} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Legacy row: proposed before agents had to give a reason, so it falls back to the description
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-legacy',
              reason: null,
              description: 'Weekly backlog sweep',
              proposedBySessionId: null,
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        No identity at all: the sessionless external MCP registration stamps no agent path
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-anonymous',
              reason: null,
              description: null,
              proposedBySessionId: null,
              proposedByAgentPath: null,
              proposedByName: null,
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A cron nothing can parse: the raw expression stands in, and there are no run times to
        promise
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-badcron',
              displayName: 'Hourly triage',
              cron: 'every other tuesday',
              timezone: null,
              nextRuns: [],
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A proposal with no name of its own — the file-safe name carries it, and the schedule runs
        with the keys
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-unnamed',
              displayName: null,
              permissionMode: 'bypassPermissions',
              proposedByName: null,
            })}
          />
        </div>
      </ShowcaseDemo>

      {/* The two transient states. Both are reachable here by pressing the real
          buttons — the card owns its decision and its run, so a prop that forced
          them would be a drawing of the card rather than the card. */}
      <ShowcaseLabel>
        Press Approve for the receipt (it names the first run), Reject for the held &ldquo;Rejected
        · Undo&rdquo;, and Run it once for the test-run strip
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-lg flex-col gap-3">
          <ScheduleApprovalCard task={proposal({ id: 'task-decide-1' })} />
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-decide-2',
              displayName: 'Weekly digest',
              cron: '0 17 * * 5',
              reason: 'The week ends with nobody having read the week.',
            })}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
