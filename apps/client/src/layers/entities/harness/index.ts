/**
 * Harness entity — what DorkOS shares with each agent tool for one project,
 * read and drawn.
 *
 * A path in, a list out. `entities` and not `features` for the same reason
 * `SkillPacksList` gave: it owns the shape of a row and no surface owns it
 * instead, so a second drawing of the same fact cannot drift. The profile
 * feature composes it, which is the allowed direction.
 *
 * Nothing in this slice writes. The sync — the banner, the mutation and the
 * "what changed" summary — is a separate change; this half is what a person
 * reads.
 *
 * @module entities/harness
 */

// --- Query key factory ---
export { harnessKeys } from './api/query-keys';

// --- Query hooks ---
export { useHarnessStatus } from './model/use-harness-status';
// Reads whatever the key already holds and never asks for one — the profile
// row's number, which must not cost three filesystem walks on every open.
export { useHarnessStatusCached } from './model/use-harness-status-cached';

// --- Display helpers (pure) ---
export {
  HARNESS_CHIP_TONE,
  collapsedChipLabel,
  groupDropsByHarness,
  harnessChipDescription,
  harnessChipWord,
  harnessRowCells,
  harnessRowKey,
  isRowFullyShared,
  projectEntryHeading,
} from './lib/harness-status';
export type {
  HarnessChipTone,
  HarnessDropEntry,
  HarnessDropGroup,
  HarnessRowCell,
} from './lib/harness-status';

// --- UI ---
export { SkillsWithHarnessesList } from './ui/SkillsWithHarnessesList';
export type { SkillsWithHarnessesListProps } from './ui/SkillsWithHarnessesList';
export { SkillHarnessRow, ADOPTABLE_ADVICE } from './ui/SkillHarnessRow';
export type { SkillHarnessRowProps } from './ui/SkillHarnessRow';
export { HarnessStateChip } from './ui/HarnessStateChip';
export type { HarnessStateChipProps } from './ui/HarnessStateChip';
export { NotSharedPanel } from './ui/NotSharedPanel';
export type { NotSharedPanelProps } from './ui/NotSharedPanel';
export { ProjectLevelNoticesPanel } from './ui/ProjectLevelNoticesPanel';
export type { ProjectLevelNoticesPanelProps } from './ui/ProjectLevelNoticesPanel';
export { NotEnabledNotice } from './ui/NotEnabledNotice';
export type { NotEnabledNoticeProps } from './ui/NotEnabledNotice';

// --- Fixtures ---
// The statuses the tests and the Dev Playground showcase both draw, so a
// showcase and a test are never looking at two different trees.
export {
  HARNESS_STATUS_ALL_SHARED,
  HARNESS_STATUS_NOT_SET_UP,
  HARNESS_STATUS_NO_SKILLS,
  HARNESS_STATUS_READY,
  HARNESS_STATUS_UNAVAILABLE,
  HARNESS_STATUS_UNREADABLE,
} from './__fixtures__/harness-status';
