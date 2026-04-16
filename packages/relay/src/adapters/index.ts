/**
 * Barrel export for relay runtime adapters that are addressable as a group.
 *
 * Historically each adapter is re-exported directly from the package root
 * (see `packages/relay/src/index.ts`). This barrel exists so that subclass
 * adapters of `RuntimeAdapter` — which the Phase 3 spec treats as a
 * cohesive family — can be imported together when needed.
 *
 * @module relay/adapters
 */

export { TestModeAdapter, type TestModeAdapterOptions } from './test-mode/index.js';
