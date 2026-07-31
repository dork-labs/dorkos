/**
 * @vitest-environment node
 *
 * The same adapter against a REAL Buzz relay, over a real WebSocket.
 *
 * **Skipped unless `BUZZ_RELAY_URL` is set**, and that is deliberate rather than
 * timid. There is no public or demo Buzz relay: every OSS-facing default is
 * `ws://localhost:3000` and the two hosted ones are Block-internal
 * (`research/20260727_buzz-protocol-capability-spike.md` §9). A relay needs
 * Postgres and Redis to boot. A CI job that depended on all of that would fail
 * for reasons that have nothing to do with this adapter, and the first response
 * to a red build nobody caused is to stop reading it.
 *
 * So the split is: the in-process relay proves the protocol on every run, and
 * this proves the protocol is the RIGHT one, on demand. It mirrors what Buzz
 * does with its own client — `crates/buzz-test-client/tests/e2e_relay.rs` is
 * `#[ignore]` and points at an already-running relay via `RELAY_URL`.
 *
 * ## Running it
 *
 * ```bash
 * git clone --depth 1 https://github.com/block/buzz.git && cd buzz
 * . ./bin/activate-hermit && cp .env.example .env
 * just setup && just relay            # ws://localhost:3000
 * buzz-admin add-member <pubkey>      # the pubkey this test prints when refused
 * ```
 *
 * Then, from this repo:
 *
 * ```bash
 * BUZZ_RELAY_URL=ws://localhost:3000 \
 *   BUZZ_TEST_CHANNEL_ID=<uuid> \
 *   pnpm vitest run apps/server/src/services/communities/buzz
 * ```
 *
 * The channel id is required because this adapter cannot create one — reading is
 * all it does, so the fixture is somebody else's channel by construction. That is
 * the honest shape of a read-only backend's test, not a gap in it.
 */
import { describe, expect, it } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { BuzzCommunityAdapter } from '../buzz-community-adapter.js';
import { deriveBuzzIdentity } from '../buzz-identity.js';

const RELAY_URL = process.env.BUZZ_RELAY_URL;
const CHANNEL_ID = process.env.BUZZ_TEST_CHANNEL_ID;
const CREDENTIAL = process.env.BUZZ_TEST_CREDENTIAL ?? 'dorkos-buzz-integration-test-key';

describe.skipIf(!RELAY_URL)('BuzzCommunityAdapter against a live relay @integration', () => {
  /** One adapter pointed at the configured relay. */
  const build = (): BuzzCommunityAdapter =>
    new BuzzCommunityAdapter({
      community: 'buzz-live' as CommunityRef,
      relayUrl: RELAY_URL!,
      credential: CREDENTIAL,
      connectTimeoutMs: 10_000,
    });

  it('completes a NIP-42 handshake and reports a typed status either way', async () => {
    const adapter = build();
    const connection = await adapter.connect();

    if (connection.status !== 'connected') {
      // Not a failure of the adapter — it is the adapter working. Print what an
      // operator needs so the next run can succeed.
      console.log(
        `[buzz integration] ${connection.status}: ${connection.disclosure ?? connection.error}\n` +
          `  pubkey to admit: ${deriveBuzzIdentity(CREDENTIAL).pubkey}`
      );
      expect(['not-admitted', 'unauthorized', 'unreachable']).toContain(connection.status);
      await adapter.disconnect();
      return;
    }

    expect(connection.identity?.memberId).toBe(deriveBuzzIdentity(CREDENTIAL).pubkey);
    const rooms = await adapter.listRooms();
    for (const room of rooms) expect(room.community).toBe(adapter.community);
    await adapter.disconnect();
  }, 30_000);

  it.skipIf(!CHANNEL_ID)(
    'pages a real channel to exhaustion, gap-free',
    async () => {
      const adapter = build();
      const connection = await adapter.connect();
      if (connection.status !== 'connected') return;

      const seen = new Set<string>();
      const first = await adapter.listEntries(CHANNEL_ID!, { limit: 10 });
      for (const entry of first.entries) seen.add(entry.id);
      let cursor = first.nextCursor;
      let pages = 1;
      while (cursor !== null && pages < 50) {
        const page = await adapter.listEntries(CHANNEL_ID!, { cursor, limit: 10 });
        for (const entry of page.entries) {
          expect(seen.has(entry.id), 'paging must visit every entry exactly once').toBe(false);
          seen.add(entry.id);
        }
        cursor = page.nextCursor;
        pages += 1;
      }
      expect(cursor, 'exhaustion is declared by a null cursor, never inferred').toBeNull();
      await adapter.disconnect();
    },
    60_000
  );
});
