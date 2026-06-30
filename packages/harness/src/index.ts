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
export * from './scan/scanner.js';
export * from './sources/resolve-roots.js';
export * from './generate/hooks.js';
export * from './apply/apply.js';
export * from './report/drop-list.js';
export * from './engine.js';
