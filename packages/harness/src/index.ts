/**
 * `@dorkos/harness` — the cross-agent file projection engine.
 *
 * Projects skills, instructions, hooks, and commands from a canonical source
 * (`.agents/`, and marketplace-installed plugins) to every enabled agent
 * harness, with an honest per-harness drop list. `adopt/` is the way an asset an
 * agent wrote in one tool's own folder gets INTO that canonical source.
 */
export * from './manifest/schema.js';
export * from './manifest/notices.js';
export * from './vendor/rulesync-maps.js';
export * from './vendor/gemini-maps.js';
export * from './plan/types.js';
export * from './plan/projector.js';
export * from './plan/hooks-projection.js';
export * from './plan/instructions.js';
export * from './plan/command-formats.js';
export * from './plan/installed-projector.js';
export * from './plan/global-projector.js';
export * from './plan/global-installs.js';
export * from './plan/unreadable-hooks.js';
export * from './plan/source-artifacts.js';
export * from './inventory/index.js';
export * from './scan/scanner.js';
export * from './scaffold/instructions.js';
export * from './scaffold/manifest.js';
export * from './scaffold/enable-harness.js';
export * from './scaffold/declare-claude-only.js';
export * from './sources/resolve-roots.js';
export * from './sources/installed.js';
export * from './generate/hooks.js';
export * from './adopt/index.js';
export * from './apply/apply.js';
export * from './apply/global-apply.js';
export * from './apply/gitignore.js';
// The Windows link decision. Named exports rather than `export *`, so that
// `setDirSymlinkProbe` — which decides what kind of link every sync makes — is
// NOT on the package's surface: it exists for tests, which reach it by importing
// the module directly, and a consumer able to set it could poison the answer for
// a whole process.
export {
  JUNCTION_COMMIT_WARNING,
  canSymlinkDirs,
  isJunctionAt,
  junctionCommitWarnings,
  symlinkTypeFor,
} from './apply/windows-links.js';
// The generated-hooks half of apply, kept in its own module: only the orphan
// sweep is part of the package's surface, the rest is apply's business.
export { sweepGeneratedOrphans } from './apply/generated-targets.js';
export * from './report/drop-list.js';
export * from './report/adoptable.js';
export * from './vendor-facts/index.js';
export * from './vendor-facts/coverage.js';
export * from './engine.js';
