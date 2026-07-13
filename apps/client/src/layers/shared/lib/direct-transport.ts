/**
 * Direct Transport — in-process Transport adapter for the Obsidian plugin.
 *
 * Core session/command methods delegate to injected services; Tasks, Relay,
 * Mesh registry, and other server-only subsystems use stub implementations
 * from `embedded-mode-stubs.ts`.
 *
 * All domain methods are produced by dedicated factory modules under
 * `direct/` and composed here via `Object.assign`. Declaration merging
 * (`interface DirectTransport extends ...`) makes the full method surface
 * visible to TypeScript without verbose `declare` blocks — the same pattern
 * as `transport/http-transport.ts`.
 *
 * @module shared/lib/direct-transport
 */
import type { Transport } from '@dorkos/shared/transport';
import type { DirectTransportServices } from './direct/services';
import { createDirectSessionMethods } from './direct/session-methods';
import { createDirectSessionStreamMethods } from './direct/session-stream-methods';
import { createDirectSystemMethods } from './direct/system-methods';
import { createDirectMeshMethods } from './direct/mesh-methods';
import { createDirectFeedbackMethods } from './direct/feedback-methods';
import { createEmbeddedStubMethods } from './direct/stub-methods';

export type { DirectTransportServices } from './direct/services';

// ---------------------------------------------------------------------------
// Declaration merging
//
// Merging the factory return types into the class interface is the idiomatic
// TypeScript pattern for mixin / composition classes. Each factory's return type
// is structurally checked against the Transport interface at compile time, so
// missing or mismatched methods surface as errors in the factory file — not here.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface DirectTransport
  extends
    ReturnType<typeof createDirectSessionMethods>,
    ReturnType<typeof createDirectSessionStreamMethods>,
    ReturnType<typeof createDirectSystemMethods>,
    ReturnType<typeof createDirectMeshMethods>,
    ReturnType<typeof createDirectFeedbackMethods>,
    ReturnType<typeof createEmbeddedStubMethods> {}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/** In-process implementation of the Transport interface for the Obsidian plugin. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class DirectTransport implements Transport {
  /** Lock identity for the embedded client (single-client, but lock-honest). */
  readonly clientId = `embedded-${crypto.randomUUID()}`;

  constructor(services: DirectTransportServices) {
    Object.assign(
      this,
      createDirectSessionMethods(services, () => this.clientId),
      createDirectSessionStreamMethods(services),
      createDirectSystemMethods(services),
      createDirectMeshMethods(),
      createDirectFeedbackMethods(),
      createEmbeddedStubMethods()
    );
  }
}
