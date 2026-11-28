/**
 * The inbox kinds the run record's outbox tells a person through (spec
 * `turns-survive-restarts` §6.2, §7.4), in one place for the notification
 * registry to declare: a mini app's start that never ran, and a turn a
 * restart touched.
 *
 * @module services/runs/effects/notice-kinds
 */
export { WORK_NOT_STARTED_ENTRIES, type WorkNotStartedPayloads } from './work-not-started.js';
export { RESTART_NOTICE_ENTRIES, type RestartNoticePayloads } from './restart-notices.js';
