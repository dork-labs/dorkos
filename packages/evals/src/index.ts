/**
 * `@dorkos/evals` — the headless outcome-oracle eval harness.
 *
 * Public surface: the core types, the sandbox + server + drive + budget runner
 * primitives, the oracle primitives, and the transcript/results reporters.
 *
 * @module evals
 */
export * from './types.js';
export * from './runner/sandbox.js';
export * from './runner/harness-server.js';
export * from './runner/isolation/index.js';
export * from './runner/drive.js';
export * from './runner/budget.js';
export * from './runner/run-eval.js';
export * from './runner/run-suite.js';
export * from './oracles/index.js';
export * from './report/transcript.js';
export * from './report/summary.js';
export * from './suite/index.js';
