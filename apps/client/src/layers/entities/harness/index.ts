/**
 * Harness entity — what DorkOS shares with each agent tool for one project,
 * read and drawn.
 *
 * A path in, a list out. `entities` and not `features`, for the reason the
 * skill-pack list it replaced gave: it owns the shape of a row and no surface
 * owns it instead, so a second drawing of the same fact cannot drift. The
 * profile feature composes it, which is the allowed direction.
 *
 * It writes in exactly one place: the sync — the drift banner, its mutation and
 * the "what changed" summary that replaces it. Everything else here reads.
 *
 * **This barrel is the slice's whole public surface, and nothing more.** The
 * key factory, the pure display helpers in `lib/harness-status.ts` and every
 * component's props type are deliberately NOT here: the modules inside this
 * slice reach them by relative path, no surface outside has ever needed one,
 * and a re-export nothing imports is dead surface that `pnpm knip` names. A
 * later slice that needs one adds the line it needs.
 *
 * @module entities/harness
 */

// --- Query hooks ---
export { useHarnessStatus } from './model/use-harness-status';
// Reads whatever the key already holds and never asks for one — the profile
// row's number, which must not cost three filesystem walks on every open.
export { useHarnessStatusCached } from './model/use-harness-status-cached';

// --- UI ---
// One name for the whole top-of-page area: the banner, and the summary that
// takes its place after a sync. The page mounts it with a project path and
// nothing else.
export { HarnessDriftBanner } from './ui/HarnessDriftBanner';
export { HarnessSyncSummary } from './ui/HarnessSyncSummary';
export { SkillsWithHarnessesList } from './ui/SkillsWithHarnessesList';
export { SkillHarnessRow } from './ui/SkillHarnessRow';
export { HarnessStateChip } from './ui/HarnessStateChip';
export { NotSharedPanel } from './ui/NotSharedPanel';
export { ProjectLevelNoticesPanel } from './ui/ProjectLevelNoticesPanel';
export { NotEnabledNotice } from './ui/NotEnabledNotice';

// --- Fixtures ---
// Exported from the production barrel because the Dev Playground showcase
// (DOR-1894) draws them, and a showcase that built its own statuses would be a
// second, drifting copy of the shapes these components are tested against.
export {
  HARNESS_STATUS_ALL_SHARED,
  HARNESS_STATUS_NOT_SET_UP,
  HARNESS_STATUS_NO_SKILLS,
  HARNESS_STATUS_READY,
  HARNESS_STATUS_UNAVAILABLE,
  HARNESS_STATUS_UNREADABLE,
} from './__fixtures__/harness-status';
