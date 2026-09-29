/**
 * "Needs You", grouped by project (spec `flow-multiproject` §6.3, V2).
 *
 * @module widgets/inbox-bell/ui/WaitingGroups
 */
import type { ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { ExtensionDecisionDTO } from '@dorkos/shared/extension-decision-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import type { Task } from '@dorkos/shared/types';
import { AskList } from '@/layers/features/ask';
import { ApprovalList } from '@/layers/features/approvals';
import { InboxProjectHeading, groupByProject } from '@/layers/features/inbox';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import { ExtensionDecisionList } from './ExtensionDecisionList';

/** One waiting thing, tagged with what it is. */
type Waiting =
  | { kind: 'ask'; ask: InteractionPendingEvent }
  | { kind: 'approval'; approval: PendingApproval }
  | { kind: 'decision'; decision: ExtensionDecisionDTO }
  | { kind: 'schedule'; task: Task };

/** The project a waiting thing belongs to, or null. */
function projectOf(item: Waiting): ProjectRef | null {
  switch (item.kind) {
    case 'ask':
      return item.ask.project ?? null;
    case 'approval':
      return item.approval.project ?? null;
    case 'decision':
      return item.decision.project;
    case 'schedule':
      return item.task.project ?? null;
  }
}

/** Props for {@link WaitingGroups}. */
export interface WaitingGroupsProps {
  /** Prompts agents are parked on. */
  asks: readonly InteractionPendingEvent[];
  /** Whether an answered prompt is still saying how it ended. */
  hasSettlingAsks: boolean;
  /** Capability approvals to draw, answered ones still settling included. */
  approvals: PendingApproval[];
  /** What extensions are asking. */
  decisions: readonly ExtensionDecisionDTO[];
  /** Parked schedules to draw, answered ones still settling included. */
  schedules: readonly Task[];
  /** Session id → what to call its agent. */
  agentNames?: Readonly<Record<string, string>>;
  /** Open a session, closing the Inbox. */
  onOpenSession: (sessionId: string) => void;
  /** Open an in-app path, closing the Inbox. */
  onNavigate: (path: string) => void;
  /** A schedule card is taking the person to its page. */
  onScheduleNavigate: () => void;
}

/**
 * Everything waiting, under a small project heading per project when two or
 * more projects have something waiting; with one, the heading hides and the
 * lists draw exactly as they always have.
 *
 * Every kind keeps its own row: tool approvals, questions and schedules look
 * as they always did, and what extensions ask uses the short decision row.
 * Groups are ordered by their most urgent item (prompts first, since their
 * window is shortest), and anything in no project comes last, with no heading.
 * A project heading's right-hand label is the one an extension gave it
 * ("Linear DOR"); core does not know trackers.
 *
 * @param props - The waiting queues and where things open.
 */
export function WaitingGroups({
  asks,
  hasSettlingAsks,
  approvals,
  decisions,
  schedules,
  agentNames,
  onOpenSession,
  onNavigate,
  onScheduleNavigate,
}: WaitingGroupsProps) {
  const waiting: Waiting[] = [
    ...asks.map((ask) => ({ kind: 'ask' as const, ask })),
    ...approvals.map((approval) => ({ kind: 'approval' as const, approval })),
    ...decisions.map((decision) => ({ kind: 'decision' as const, decision })),
    ...schedules.map((task) => ({ kind: 'schedule' as const, task })),
  ];
  const groups = groupByProject(waiting, projectOf);
  const grouped = groups.some((group) => group.project !== null);

  // Nothing is waiting but an answered prompt is still saying how it ended:
  // one headingless group, so the receipt has somewhere to be drawn.
  if (groups.length === 0 && hasSettlingAsks) {
    groups.push({ project: null, items: [] });
  }

  // Every piece is a keyed sibling in ONE flat list, keyed by what it holds
  // rather than by which group it sits in. When the headings appear or go
  // (one project becomes two), React keeps each row where it is instead of
  // remounting it, so a half-typed answer and focus survive the regroup.
  const roots = new Set(groups.map((group) => group.project?.root ?? null));
  const nodes: ReactNode[] = [];
  groups.forEach((group, index) => {
    const groupAsks: InteractionPendingEvent[] = [];
    const groupApprovals: PendingApproval[] = [];
    const groupDecisions: ExtensionDecisionDTO[] = [];
    const groupSchedules: Task[] = [];
    for (const item of group.items) {
      if (item.kind === 'ask') groupAsks.push(item.ask);
      else if (item.kind === 'approval') groupApprovals.push(item.approval);
      else if (item.kind === 'decision') groupDecisions.push(item.decision);
      else groupSchedules.push(item.task);
    }
    const root = group.project?.root ?? null;
    const last = index === groups.length - 1;
    // A receipt belongs to the group of the project it was asked in; one whose
    // group is gone (its last prompt answered) is drawn with the last group,
    // never dropped. With no headings every receipt belongs here.
    const holds = grouped
      ? (ask: InteractionPendingEvent) => {
          const own = ask.project?.root ?? null;
          return own === root || (last && !roots.has(own));
        }
      : undefined;
    const label =
      groupDecisions
        .filter((decision) => decision.projectLabel)
        .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))[0]?.projectLabel ?? null;

    if (grouped && group.project) {
      nodes.push(
        <InboxProjectHeading key={`heading:${root}`} name={group.project.name} label={label} />
      );
    }
    if (groupAsks.length > 0 || (hasSettlingAsks && (last || !grouped))) {
      nodes.push(
        <AskList
          // Keyed by kind and group, never by an item: answering the top card
          // reorders the list, and a remount would drop focus and drafts.
          key={`asks:${root ?? 'loose'}`}
          asks={groupAsks}
          agentNames={agentNames}
          onOpenSession={onOpenSession}
          holds={holds}
          emptyState={
            grouped ? null : <p className="text-muted-foreground text-xs">Nothing needs you</p>
          }
        />
      );
    }
    if (groupApprovals.length > 0) {
      nodes.push(<ApprovalList key={`approvals:${root ?? 'loose'}`} approvals={groupApprovals} />);
    }
    // Decisions are keyed one by one (a row keeps its open field when the
    // headings come and go), and spaced as one list.
    groupDecisions.forEach((decision, position) => {
      nodes.push(
        <div
          key={`decision:${decision.id}`}
          data-slot="inbox-waiting-decision"
          data-project={decision.project?.name ?? ''}
          className={position === 0 ? 'mt-2' : 'mt-1'}
        >
          <ExtensionDecisionList
            decisions={[decision]}
            onNavigate={onNavigate}
            onWatch={onOpenSession}
            flush
          />
        </div>
      );
    });
    if (groupSchedules.length > 0) {
      nodes.push(
        <div key={`schedules:${root ?? 'loose'}`} className="mt-3">
          <h3 className="text-status-warning-fg sr-only text-xs font-medium tracking-widest uppercase md:not-sr-only">
            Scheduled Runs
          </h3>
          {/* `AnimatePresence` keeps a decided card mounted long enough to say
              so; see `InboxBell`'s own note. */}
          <AnimatePresence initial={false}>
            {groupSchedules.map((task) => (
              <ScheduleApprovalCard
                key={task.id}
                task={task}
                className="mt-2"
                onNavigate={onScheduleNavigate}
              />
            ))}
          </AnimatePresence>
        </div>
      );
    }
  });

  return <div data-slot="inbox-waiting">{nodes}</div>;
}
