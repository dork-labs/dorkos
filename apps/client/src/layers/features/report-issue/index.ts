/**
 * Report-issue feature — help and feedback, and the ways out to GitHub.
 *
 * Surfaces bug and feature reporting as menu rows the sidebar footer's `⋯` fold
 * renders. The report logic (gather safe details, build a prefilled GitHub issue
 * URL, open it) lives in `@/layers/shared/model` (`useReportIssue`) so the
 * command palette can reuse it without a cross-feature dependency.
 *
 * @module features/report-issue
 */
export { HelpMenuItems } from './ui/HelpMenuItems';
