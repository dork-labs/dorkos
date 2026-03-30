/**
 * HTTP Transport — implements the Transport interface for standalone web clients.
 *
 * All domain methods are produced by dedicated factory modules and composed here
 * via `Object.assign`. Declaration merging (`interface HttpTransport extends ...`)
 * makes the full method surface visible to TypeScript without verbose `declare` blocks.
 *
 * @module shared/lib/transport/http-transport
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createTasksMethods } from './task-methods';
import { createRelayMethods } from './relay-methods';
import { createMeshMethods } from './mesh-methods';
import { createSessionMethods } from './session-methods';
import { createSystemMethods } from './system-methods';

// ---------------------------------------------------------------------------
// Declaration merging
//
// Merging the factory return types into the class interface is the idiomatic
// TypeScript pattern for mixin / composition classes. Each factory's return type
// is structurally checked against the Transport interface at compile time, so
// missing or mismatched methods surface as errors in the factory file — not here.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface HttpTransport
  extends
    ReturnType<typeof createTasksMethods>,
    ReturnType<typeof createRelayMethods>,
    ReturnType<typeof createMeshMethods>,
    ReturnType<typeof createSessionMethods>,
    ReturnType<typeof createSystemMethods> {}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/** HTTP implementation of the Transport interface for standalone web clients. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class HttpTransport implements Transport {
  readonly clientId: string;
  private readonly etagCache = new Map<string, string>();
  private readonly messageCache = new Map<string, { messages: HistoryMessage[] }>();

  constructor(private readonly baseUrl: string) {
    this.clientId = `web-${crypto.randomUUID()}`;
    Object.assign(
      this,
      createTasksMethods(baseUrl),
      createRelayMethods(baseUrl, () => this.clientId),
      createMeshMethods(baseUrl),
      createSessionMethods(baseUrl, () => this.clientId, this.etagCache, this.messageCache),
      createSystemMethods(baseUrl)
    );
  }
}
