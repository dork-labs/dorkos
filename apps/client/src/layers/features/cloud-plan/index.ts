/**
 * Cloud-plan feature — the plan-aware surfaces behind a DorkOS account
 * (DOR-2027): the plan card, the credits gauge with its per-agent breakdown and
 * local spend view, the upgrade nudge, and seat management.
 *
 * Its sibling `features/cloud-link` owns the door — the device-link flow — and
 * this owns the room behind it. Settings composes both into one section.
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
 * FSD: `features/cloud-plan` — imports only from `entities`, `shared` and its
 * own slice.
 *
 * @module features/cloud-plan
 */
export { CloudPlanPanel } from './ui/CloudPlanPanel';
export { PlanCard } from './ui/PlanCard';
export { CreditsGauge } from './ui/CreditsGauge';
export { UpgradeNudge } from './ui/UpgradeNudge';
export { SeatManagement } from './ui/SeatManagement';
export { CreditsSource } from './ui/CreditsSource';
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
export { useLocalSpend } from './model/use-local-spend';
export type { LocalSpend } from './model/use-local-spend';
export { formatMicro, remainingFraction } from './lib/micro';
