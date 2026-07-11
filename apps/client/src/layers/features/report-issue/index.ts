/**
 * Report-issue feature — the "Report an issue" help menu and its entry points.
 *
 * Surfaces bug and feature reporting in the sidebar help menu. The report logic
 * (gather safe details, build a prefilled GitHub issue URL, open it) lives in
 * `@/layers/shared/model` (`useReportIssue`) so the command palette can reuse it
 * without a cross-feature dependency.
 *
 * @module features/report-issue
 */
export { HelpMenu } from './ui/HelpMenu';
