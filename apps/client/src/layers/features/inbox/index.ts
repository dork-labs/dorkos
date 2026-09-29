/**
 * Inbox feature — the list of what has happened, and the row it is made of
 * (spec `notification-system` §Client).
 *
 * Drawing only. The store, the read state and the mapping from a notification to
 * a mark and a destination all live in `entities/notifications`; what is here is
 * the one list three surfaces share, so that the bell, an agent's profile and
 * home cannot drift into three different ideas of what a notification looks
 * like.
 *
 * @module features/inbox
 */
export { InboxList } from './ui/InboxList';
export type { InboxListProps } from './ui/InboxList';
export { InboxRow } from './ui/InboxRow';
export type { InboxRowProps } from './ui/InboxRow';
export { InboxGroupRow } from './ui/InboxGroupRow';
export { InboxDecisionRow } from './ui/InboxDecisionRow';
export type {
  InboxDecisionRowProps,
  InboxDecisionYesNo,
  InboxDecisionWord,
  InboxDecisionChoice,
} from './ui/InboxDecisionRow';
export { InboxProjectHeading } from './ui/InboxProjectHeading';
export type { InboxProjectHeadingProps } from './ui/InboxProjectHeading';
export { groupByProject } from './lib/group-by-project';
export type { ProjectGroup } from './lib/group-by-project';
export { deadlineLine, sinceLine, decisionHistoryTrail } from './lib/decision-copy';
export type { InboxGroupRowProps } from './ui/InboxGroupRow';
export { useOpenNotification } from './model/use-open-notification';
export { groupActivityRows, MIN_BURST_SIZE } from './lib/group-activity-rows';
export type {
  InboxListItem,
  InboxRowItem,
  InboxGroupItem,
  InboxAwayItem,
} from './lib/group-activity-rows';
