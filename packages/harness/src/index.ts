/**
 * `@dorkos/harness` — the cross-agent file projection engine.
 *
 * Projects skills, instructions, hooks, and commands from a canonical source
 * (`.agents/`, marketplace-installed plugins, adopted assets) to every enabled
 * agent harness, with an honest per-harness drop list. This barrel re-exports
 * the public surface; modules are wired as they land (manifest, vendor, scan,
 * plan, apply).
 */
export * from './manifest/schema.js';
export * from './vendor/rulesync-maps.js';
export * from './vendor/gemini-maps.js';
