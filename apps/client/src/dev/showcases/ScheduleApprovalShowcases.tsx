import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { TaskRun, TaskRunStatus } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { minutesFromLoad, proposal } from './schedule-approval-fixtures';

/**
 * A transport that answers the two calls "Try it once now" makes.
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
    resolvedRuntime: null,
    resolvedModel: null,
    refusedTools: null,
    outcome: null,
    scheduledFor: null,
    missedTicks: null,
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
      description="An agent that proposes a scheduled run never arms it — it parks until somebody says yes or no. This is where they say so, and the card's whole job is that the answer is informed: who proposed it, why in their own words, the cadence with its timezone, the first few concrete run times, and the exact instructions one disclosure away. Three answers — Approve, Reject (undoable for a few seconds, because the delete is simply not sent yet), and Try it once now, which executes the prompt now as a single supervised run so the decision can be made on evidence rather than on faith. Answerable with A and D while focus is inside the card."
    >
      <ShowcaseLabel>Choosing Allowed commands with an approved watchdog command</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              id: 'task-permission-picker',
              displayName: 'Watchdog check',
              reason: 'Run at Never ask to check the watchdog on a schedule.',
              folderRules: {
                status: 'approved',
                applied: ['Bash(pnpm check:watchdog)'],
                pending: [],
              },
            })}
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>Proposed by one agent, runs as another</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="runs-as-other-agent">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              id: 'task-runs-as-other',
              agentId: 'agent-scout',
              runsAsName: 'Scout',
              displayName: 'Weekly link check',
              reason: 'Scout should check the docs links every Monday.',
            })}
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>The phone review sheet: the pinned Run permissions row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex h-[640px] w-full max-w-[390px] flex-col" data-shot="phone-pinned-row">
          <ScheduleApprovalCard
            approvalSurface="schedules"
            task={proposal({ id: 'task-phone-sheet' })}
            pinActions
            reviewHeader={<p className="pb-2 text-sm font-medium">Review schedule</p>}
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>No agent: each run gets a fresh private folder</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="run-place-private">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              id: 'task-run-place-private',
              agentId: null,
              runsAsName: null,
              displayName: 'Broken docs links',
              reason: 'Find broken links in the docs every night.',
              runPlace: { kind: 'private' },
            })}
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>A looser picked mode needs its own tick</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="run-looser">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              requestedPermissionMode: 'dontAsk',
              permissionMode: 'dontAsk',
              displayName: 'Weekly cleanup',
              reason: 'Tidy old branches every Sunday.',
            })}
            initialPickedMode="acceptEdits"
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>A looser picked mode and a program rule share one tick</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="looser-programs">
          <ScheduleApprovalCard
            approvalSurface="inbox"
            task={proposal({
              id: 'task-looser-programs',
              approvalRevision: 'c'.repeat(64),
              folderRules: { status: 'none', applied: [], pending: [] },
              displayName: 'Nightly report',
              reason: 'Run the report script each night and nothing else.',
              permissionMode: 'dontAsk',
              requestedPermissionMode: 'dontAsk',
              requestedAllow: ['Bash(/Users/sam/reports/nightly.sh --once)'],
            })}
            initialPickedMode="acceptEdits"
          />
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>
        After a yes: the receipt names who approved it, when, and where (press Approve)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="approval-receipt">
          <ScheduleApprovalCard
            approvalSurface="inbox"
            task={proposal({
              id: 'task-approval-receipt',
              displayName: 'Weekly invoices',
              reason: 'Send the invoice summary every Friday.',
              approvalRevision: 'a'.repeat(64),
              folderRules: { status: 'approved', applied: [], pending: [] },
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The agent asked for Allowed commands and one exact command: shown, flagged as running
        programs, and confirmed with its own tick
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="requested-allow">
          <ScheduleApprovalCard
            approvalSurface="inbox"
            task={proposal({
              id: 'task-requested-allow',
              displayName: 'Nightly report',
              reason: 'Run the report script each night and nothing else.',
              permissionMode: 'dontAsk',
              requestedPermissionMode: 'dontAsk',
              requestedAllow: ['Bash(/Users/sam/reports/nightly.sh --once)'],
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Proposed after reading outside words: starts at the tightest mode, and its rules take a
        separate tick
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="outsider-default">
          <ScheduleApprovalCard
            approvalSurface="schedules"
            task={proposal({
              id: 'task-outsider-default',
              folderRules: { status: 'none', applied: [], pending: [] },
              approvalRevision: 'd'.repeat(64),
              displayName: 'Inbox digest',
              reason: 'Sum up the support inbox every morning.',
              originMarks: { outsider: true },
              requestedPermissionMode: 'acceptEdits',
              requestedAllow: ['Read(/Users/sam/support/inbox.md)'],
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Everything present: a reason, a named proposer, a session to open, three run times
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg" data-shot="plain-approve">
          <ScheduleApprovalCard
            task={proposal({
              approvalRevision: 'b'.repeat(64),
              folderRules: { status: 'none', applied: [], pending: [] },
            })}
            approvalSurface="home"
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Found in a file, not proposed by anyone — names the file, and DorkOS’s own words are not
        dressed as a quotation
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            approvalSurface="home"
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
            approvalSurface="home"
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
        Waiting again after an agent changed how it runs — the card lists old → new (DOR-2323)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              id: 'task-settings-changed',
              proposedBySessionId: null,
              proposedByAgentPath: null,
              proposedByName: null,
              reasonSource: 'dorkos',
              reason:
                'An agent changed how this schedule runs, so it is waiting for you again. Check what changed, then approve it or change it back.',
              runtime: 'codex',
              model: 'gpt-5',
              maxRuntime: 7_200_000,
              approvalChanges: [
                { field: 'runtime', from: null, to: 'codex', via: 'schedule' },
                { field: 'model', from: 'claude-sonnet-4', to: 'gpt-5', via: 'schedule' },
                { field: 'maxRuntime', from: 600_000, to: 7_200_000, via: 'schedule' },
              ],
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Waiting again because its agent’s model was changed outside DorkOS (DOR-2337)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            approvalSurface="home"
            task={proposal({
              id: 'task-agent-changed-outside',
              proposedBySessionId: null,
              proposedByAgentPath: null,
              proposedByName: null,
              reasonSource: 'dorkos',
              reason:
                'This schedule runs on its agent’s own runtime, model or effort, and those were changed outside DorkOS, so it is waiting for you again. Check what changed, then approve it or change the agent back.',
              approvalChanges: [
                { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
                { field: 'effort', from: null, to: 'max', via: 'agent' },
              ],
            })}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        In a narrow panel — the Inbox popover and the Pulse rail are both about this wide
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-[22rem]">
          <ScheduleApprovalCard task={proposal({ id: 'task-narrow' })} approvalSurface="home" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Legacy row: proposed before agents had to give a reason, so it falls back to the description
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-lg">
          <ScheduleApprovalCard
            approvalSurface="home"
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
            approvalSurface="home"
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
            approvalSurface="home"
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
            approvalSurface="home"
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
        Press Approve for the receipt (it names the first run), or Reject for the held “Rejected ·
        Undo” — it takes about five seconds to pass
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-lg flex-col gap-3">
          <ScheduleApprovalCard task={proposal({ id: 'task-decide-1' })} approvalSurface="home" />
          <ScheduleApprovalCard
            approvalSurface="home"
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
        Try it once now — press it on each card for the strip’s three readings: still going,
        finished with a way into what it did, and an honest failure
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full max-w-lg flex-col gap-3">
          <TestRunBench outcome="running">
            <ScheduleApprovalCard
              task={proposal({ id: 'task-run-going' })}
              approvalSurface="home"
            />
          </TestRunBench>
          <TestRunBench outcome="completed">
            <ScheduleApprovalCard
              approvalSurface="home"
              task={proposal({ id: 'task-run-done', displayName: 'Morning standup (finishes)' })}
            />
          </TestRunBench>
          <TestRunBench outcome="failed">
            <ScheduleApprovalCard
              approvalSurface="home"
              task={proposal({ id: 'task-run-failed', displayName: 'Morning standup (fails)' })}
            />
          </TestRunBench>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
