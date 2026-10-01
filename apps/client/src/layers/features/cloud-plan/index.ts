/**
 * Cloud-plan feature — the plan-aware surfaces behind a DorkOS account
 * (DOR-2027): the plan card, the credits gauge with its per-agent breakdown and
 * local spend view, the upgrade nudge, "Use credits for", what is on the
 * account, seat management, the one-line account status the header menu
 * shows (DOR-2628), and the buttons that open the billing pages on the web
 * (DOR-2632).
 *
 * Its sibling `features/cloud-link` owns the door — the device-link flow — and
 * this owns the room behind it. Settings › DorkOS account composes both.
 *
 * Two properties hold across every file in the slice:
 *
 * - **Catalog blindness.** No plan name, plan id or price is written down
 *   anywhere. Plan-shaped strings are the service's `displayName` fields, every
 *   number is a figure the service sent, and identifiers are opaque.
 * - **Graceful degradation.** Every read answers "nothing to show" rather than
 *   failing when this instance has no cloud account, so the whole section
 *   collapses to one line on an install that has never touched the cloud.
 *
 * FSD: `features/cloud-plan` — imports from `entities`, `shared` and its own
 * slice; reads the link summary and composes one piece of `features/cloud-link`
 * UI (the line saying who can buy a plan) through that slice's barrel, and
 * lists the account's communities through `features/community-hosting`'s.
 *
 * @module features/cloud-plan
 */
export { CloudPlanPanel } from './ui/CloudPlanPanel';
export { PlanCard } from './ui/PlanCard';
export { CreditsGauge } from './ui/CreditsGauge';
export { UpgradeNudge } from './ui/UpgradeNudge';
export { SeatManagement } from './ui/SeatManagement';
export {
  ManageOnWeb,
  BillingPageButton,
  PlanOffers,
  BillingNoticeView,
  ExportAccountData,
} from './ui/ManageOnWeb';
export type { BillingPageButtonProps, PlanOffersProps } from './ui/ManageOnWeb';
export {
  cloudPlanKeys,
  useCloudCredits,
  useCloudMembers,
  useCloudNudge,
  useCloudOrgs,
  useCloudPlan,
  useCloudSeats,
  useCloudUsage,
  useSeatActions,
  useSelectCloudCredits,
} from './model/use-cloud-plan';
export { useAccountExport, useCloudOffers, useOpenBillingPage } from './model/use-billing-page';
export type {
  AccountExportControl,
  AccountExportState,
  BillingNotice,
  BillingPageTarget,
  OpenBillingPage,
} from './model/use-billing-page';
export { useLocalSpend } from './model/use-local-spend';
export {
  describeDorkosAccountLine,
  useDorkosAccountLine,
  type DorkosAccountLine,
} from './model/use-dorkos-account-line';
export { readCreditsFor } from './model/use-credits-for';
export type { LocalSpend } from './model/use-local-spend';
export { remainingFraction } from './lib/remaining-fraction';
