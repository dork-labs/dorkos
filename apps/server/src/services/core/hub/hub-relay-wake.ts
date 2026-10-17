/**
 * The hub's half of waking a linked computer (B1, DOR-2944): asking DorkOS
 * Cloud to send that computer a `viewer_open` command, through this hub's own
 * key (`DORKOS_HUB_INSTANCE_KEY`). The command carries no address, so the
 * computer dials only the hub it pinned when its owner linked it.
 *
 * A hub with no key wakes nobody: a page that opens a sleeping computer's
 * chat just hears "waking", as before.
 *
 * @module services/core/hub/hub-relay-wake
 */
import { ViewerOpenResponseSchema, v1Path } from '@dork-labs/cloud-api';

import { env } from '../../../env.js';
import { createCloudV1ClientFor } from '../cloud/v1-client.js';
import type { HubRelayWake } from '../hub-relay/computer-waker.js';

/**
 * How long one wake may wait on Cloud. A wake is retried by the next page
 * that asks, so a hung call ends rather than piling up behind the debounce.
 */
export const HUB_RELAY_WAKE_TIMEOUT_MS = 10_000;

/** The one Cloud call a wake needs, injectable for tests. */
export interface HubRelayWakeClient {
  post: (
    path: string,
    schema: typeof ViewerOpenResponseSchema,
    init: { body: Record<string, never>; signal: AbortSignal }
  ) => Promise<unknown>;
}

/**
 * A wake that asks Cloud to open a viewer on one computer, or `null` when
 * this hub holds no Cloud key. The computer's id is its Cloud instance id.
 *
 * @param client - Replaces the hub's own Cloud client, for tests.
 */
export function hubRelayWake(
  client: HubRelayWakeClient | null = env.DORKOS_HUB_INSTANCE_KEY
    ? createCloudV1ClientFor(env.DORKOS_HUB_INSTANCE_KEY)
    : null
): HubRelayWake | null {
  if (!client) return null;
  return async (computerId) => {
    await client.post(v1Path.instanceViewerOpen(computerId), ViewerOpenResponseSchema, {
      body: {},
      signal: AbortSignal.timeout(HUB_RELAY_WAKE_TIMEOUT_MS),
    });
  };
}
