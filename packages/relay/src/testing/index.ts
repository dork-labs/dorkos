/**
 * Testing utilities for relay adapter development.
 *
 * Provides mock factories and a compliance test suite that validates adapter
 * correctness against the full RelayAdapter contract.
 *
 * Import from `@dorkos/relay/testing` in test files:
 *
 * @example
 * ```typescript
 * import { runAdapterComplianceSuite, createMockRelayPublisher } from '@dorkos/relay/testing';
 * ```
 *
 * @module relay/testing
 */
export { runAdapterComplianceSuite } from './compliance-suite.js';
export type { ComplianceSuiteOptions } from './compliance-suite.js';
export { createMockRelayPublisher } from './mock-relay-publisher.js';
export { createMockRelayEnvelope } from './mock-relay-envelope.js';
