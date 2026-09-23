/**
 * Report-issue feature — help and feedback, and the ways out to GitHub.
 *
 * Surfaces the help-and-feedback rows the sidebar footer's `⋯` fold renders:
 * the feedback form, the person's own reports, and the docs — and the same
 * actions as rows of their own (`HelpRows`) for a phone's You tab. The prefilled
 * GitHub issue path (`useReportIssue` in `@/layers/shared/model`) is reached
 * from inside the feedback form, which is why it lives in the shared layer.
 *
 * @module features/report-issue
 */
export { HelpMenuItems } from './ui/HelpMenuItems';
export { HelpRows } from './ui/HelpRows';
