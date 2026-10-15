/** Existing harness workspace operations used by server runtime paths. */
export { extensionSkillPluginsDir } from './sources/running-extension-skills.js';
export { CLAUDE_INSTRUCTION_CONTENT } from './plan/instructions.js';
export { applyPlan } from './apply/apply.js';
export { project, loadManifest } from './engine.js';
export { readDevLinksSync } from './sources/dev-links.js';
export { scaffoldManifest, HARNESS_MANIFEST_PATH } from './scaffold/manifest.js';
export { adoptCommandFor, adoptableSentence, harnessesThatCannotSee } from './report/adoptable.js';
export { inventorySourceTree } from './inventory/index.js';
export { planAdopt } from './adopt/plan.js';
export { readAdoptCandidates } from './adopt/read.js';
export { applyAdopt } from './adopt/apply.js';
export type { AdoptCandidate, DirectoryOwnership } from './adopt/types.js';
export type { SkillRoot } from './inventory/types.js';
