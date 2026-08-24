import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { Task, TaskRun, TaskRunStatus } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';

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
    origin: null,
    reasonSource: null,
    nextRuns: [minutesFromLoad(180), minutesFromLoad(1620), minutesFromLoad(3060)],
    ...overrides,
  };
}

/**
 * A transport that answers the two calls "Run it once" makes.
 *
 * The shared playground transport resolves `null` for everything, which is
 * right for a bench of props-only showcases and wrong for this one: the card
 * asks the server to start a run and then reads the run history back, so
 * against `null` the button was a no-op and the result strip — a third of what
 * this card is for — could not be seen at all.
 *
 * Each demo pins its own OUTCOME rather than simulating a run over time. The
 * strip's three readings are the thing worth looking at, and waiting out a
 * fake run to see the third is how a bench stops being used.
 *
 * @param outcome - What the history reports for this schedule's run.
 */
function testRunTransport(outcome: TaskRunStatus): Transport {
  const base = createPlaygroundTransport();
  const run = (scheduleId: string): TaskRun => ({
    id: `${scheduleId}-run`,
    scheduleId,
    status: outcome,
    startedAt: minutesFromLoad(-2),
    finishedAt: outcome === 'running' ? null : minutesFromLoad(-1),
    durationMs: outcome === 'running' ? null : 62_000,
    outputSummary: null,
    error: outcome === 'failed' ? 'Command not found: sweep' : null,
    sessionId: outcome === 'completed' ? `${scheduleId}-session` : null,
    trigger: 'manual',
    createdAt: minutesFromLoad(-2),
  });

  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'triggerTask') {
        return async (id: string) => ({ runId: run(id).id });
      }
      if (prop === 'listTaskRuns') {
        return async (opts?: { scheduleId?: string }) =>
          opts?.scheduleId ? [run(opts.scheduleId)] : [];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * One card wired to a transport that will actually answer its test run.
 *
 * @param outcome - What the run history reports.
 * @param children - The card.
 */
function TestRunBench({ outcome, children }: { outcome: TaskRunStatus; children: ReactNode }) {
  return <TransportProvider transport={testRunTransport(outcome)}>{children}</TransportProvider>;
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
        Found in a file, not proposed by anyone — names the file, and DorkOS&rsquo;s own words are
        not dressed as a quotation
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-file-origin',
              origin: 'file',
              proposedBySessionId: null,
              proposedByAgentPath: null,
              proposedByName: null,
              filePath: '/Users/dev/project/.agents/skills/nightly-sweep/SKILL.md',
              reason:
                'DorkOS found this schedule in a file on your computer. Nothing runs on a timer until you say so — read what it does below, then approve it or delete it.',
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Found in a file DorkOS cannot fully read — the complaint names the setting to fix
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            task={proposal({
              id: 'task-file-broken',
              origin: 'file',
              proposedBySessionId: null,
              proposedByAgentPath: null,
              proposedByName: null,
              cron: '',
              nextRuns: [],
              filePath: '/Users/dev/project/.agents/skills/broken-sweep/SKILL.md',
              reason:
                'Its "cron" setting is not something DorkOS can read (String must contain at least 1 character(s)).',
            })}
          />
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

      {/* The transient states. All reachable here by pressing the real buttons —
          the card owns its decision and its run, so a prop that forced them
          would be a drawing of the card rather than the card. */}
      <ShowcaseLabel>
        Press Approve for the receipt (it names the first run), or Reject for the held
        &ldquo;Rejected · Undo&rdquo; — it takes about five seconds to pass
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

      <ShowcaseLabel>
        Run it once — press it on each card for the strip&rsquo;s three readings: still going,
        finished with a way into what it did, and an honest failure
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-lg flex-col gap-3">
          <TestRunBench outcome="running">
            <ScheduleApprovalCard task={proposal({ id: 'task-run-going' })} />
          </TestRunBench>
          <TestRunBench outcome="completed">
            <ScheduleApprovalCard
              task={proposal({ id: 'task-run-done', displayName: 'Morning standup (finishes)' })}
            />
          </TestRunBench>
          <TestRunBench outcome="failed">
            <ScheduleApprovalCard
              task={proposal({ id: 'task-run-failed', displayName: 'Morning standup (fails)' })}
            />
          </TestRunBench>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
