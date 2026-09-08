/**
 * `@dorkos/harness` — the cross-agent file projection engine.
 *
 * Projects skills, instructions, hooks, and commands from a canonical source
 * (`.agents/`, and — in later phases — marketplace-installed plugins and adopted
 * assets) to every enabled agent harness, with an honest per-harness drop list.
 */
export * from './manifest/schema.js';
export * from './vendor/rulesync-maps.js';
export * from './vendor/gemini-maps.js';
export * from './plan/types.js';
export * from './plan/projector.js';
export * from './plan/instructions.js';
export * from './plan/command-formats.js';
export * from './plan/installed-projector.js';
export * from './plan/unreadable-hooks.js';
export * from './plan/source-artifacts.js';
export * from './inventory/index.js';
export * from './scan/scanner.js';
export * from './scaffold/instructions.js';
export * from './scaffold/manifest.js';
export * from './scaffold/enable-harness.js';
export * from './sources/resolve-roots.js';
export * from './sources/installed.js';
export * from './generate/hooks.js';
export * from './apply/apply.js';
export * from './apply/gitignore.js';
// The generated-hooks half of apply, kept in its own module: only the orphan
// sweep is part of the package's surface, the rest is apply's business.
export { sweepGeneratedOrphans } from './apply/generated-targets.js';
export * from './report/drop-list.js';
export * from './vendor-facts/index.js';
export * from './vendor-facts/coverage.js';
export * from './engine.js';
