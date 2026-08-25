// db helpers exported via '@dorkos/test-utils/db' subpath (not barrel)
// to avoid pulling Node.js-only @dorkos/db into jsdom test environments.
//
// React helpers are exported via '@dorkos/test-utils/react-helpers' for the same
// reason, in the other direction: react-helpers.tsx contains JSX, so re-exporting
// it here would drag JSX into every Node-only consumer of the barrel. Those
// consumers (@dorkos/server, @dorkos/evals) use a Node tsconfig with no `jsx`
// option, so tsc fails with TS6142 the moment their test files enter a
// typechecked program.
export * from './capability-conformance.js';
export * from './community-conformance.js';
export * from './directory-membership-vectors.js';
export * from './connector-conformance.js';
export * from './fake-agent-runtime.js';
export * from './fake-community-adapter.js';
//
// listeningServer / swappableServer are exported via
// '@dorkos/test-utils/listening-server' only, for a third reason: WEIGHT. Their
// consumers are route tests, and several of those call `vi.resetModules()`
// between tests, which re-evaluates every dynamically imported module. Pulling
// the whole barrel (FakeAgentRuntime, the conformance suites, the scenario
// table) into config.test.ts to reach a 40-line http helper measured +7s across
// its 41 resets, and pushed its first `beforeEach` past the 10s hook timeout.
export * from './fake-connector-provider.js';
export * from './fake-memory-provider.js';
export * from './memory-conformance.js';
export * from './mock-factories.js';
export * from './runtime-conformance.js';
export * from './sse-helpers.js';
export * from './sse-test-helpers.js';
export * from './test-scenarios.js';
