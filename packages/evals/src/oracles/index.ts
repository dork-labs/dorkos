/**
 * Oracle primitives barrel: filesystem, API, and stream outcome oracles, plus
 * the versioned rubric-judge primitive. These oracles assert API / filesystem /
 * stream side effects — never the assistant's prose. The one exception is
 * `transcript.js`, which reads assistant text but only through DETERMINISTIC
 * structural checks (a literal question count, a fixed-phrase offer signal), not
 * judgment — see its module doc for why that preserves the "no flaky prose"
 * spirit.
 *
 * @module evals/oracles
 */
export * from './filesystem.js';
export * from './api.js';
export * from './stream.js';
export * from './transcript.js';
export * from './judge.js';
