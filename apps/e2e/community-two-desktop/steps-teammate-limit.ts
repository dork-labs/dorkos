import assert from 'node:assert/strict';
import { expect, type Locator } from '@playwright/test';
import { channelEntries, composer, json, send, sendJson, type Desktop } from './desktop.js';
import type { Entry, World } from './world.js';

/**
 * Step 22c: the card limit (DOR-2956). B's agent has already answered one of A's mentions, which
 * the scripted test runtime reports no cost for, so it counted at the estimate. B sets a monthly
 * limit below that from B's own app, A mentions B's agent again, and the post stays as history:
 * B's computer starts no turn and nothing answers. B then clears the limit, as it was.
 *
 * @module community-two-desktop/steps-teammate-limit
 */

/** What step 22c needs from the agent steps around it. */
export interface TeammateLimitStepNeeds {
  /** B's enrolled agent, by its name in the space. */
  bAgent: { display?: string };
  /** Open a channel with the Members panel showing the agent controls. */
  openAgents: (local: Desktop, ref: string, roomId: string) => Promise<void>;
  /** The "Your agents in this space" region. */
  agentsRegion: (local: Desktop) => Locator;
}

/** One space's teammate spending, as B's server reports it. */
interface Spend {
  monthlyLimitUsd: number | null;
  spentUsd: number;
  approximate: boolean;
}

/**
 * Run step 22c.
 *
 * @param w - The journey so far.
 * @param needs - B's agent and the agent-panel helpers from the agent steps.
 */
export async function teammateLimitStep(w: World, needs: TeammateLimitStepNeeds): Promise<void> {
  const { step, shot, a, b, refA, room, stamp } = w;
  const refB = w.refB;
  const spendPath = `${b.origin}/api/community-connections/${refB}/teammate-spend`;
  const probe = async () =>
    json<{ dispatchesSinceBoot: number }>(
      `${b.origin}/api/test/community-subscription?ref=${encodeURIComponent(refB)}&roomId=${encodeURIComponent(room.roomId)}`
    );

  await step(
    '22c once teammates spend B’s monthly limit, A’s mention stays as history',
    async () => {
      // B sets a limit from the Teammates block in B's own app.
      await needs.openAgents(b, refB, room.roomId);
      const teammates = needs.agentsRegion(b).getByRole('region', { name: 'Teammates' });
      await expect(teammates.getByText(/^No limit · /)).toBeVisible({ timeout: 30_000 });
      await teammates.getByLabel('Monthly limit for teammates').fill('0.10');
      const saved = b.page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/teammate-spend')
      );
      await teammates.getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal((await saved).status(), 200, 'B sets the monthly limit');
      await expect(
        teammates.getByText(/^Limit \$0\.10 a month · \$\d+\.\d\d spent this month, approximate$/)
      ).toBeVisible();
      const before = await json<Spend>(spendPath);
      assert(
        before.spentUsd >= 0.1 && before.approximate,
        'step 22’s turn counted at the estimate'
      );
      // The whole block in view: its last line is the one that says what was spent.
      await teammates.getByText(/^Past the limit/).scrollIntoViewIfNeeded();
      const blockShot = await shot(b.page, '22c-1-desktop-b-teammates-limit');

      // A mentions B's agent; B's computer starts no turn.
      const dispatched = (await probe()).dispatchesSinceBoot;
      await w.openGeneral(a, refA);
      const ask = `@b-helper this one should wait ${stamp}`;
      await send(composer(a), ask);
      // Long enough for the scripted reply step 22 saw, with room to spare.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const entries = await channelEntries<Entry>(a, refA, room.roomId);
      assert(
        entries.some((e) => e.text === ask),
        'the post is in the channel’s history'
      );
      assert(
        !entries.some(
          (e) =>
            e.authorKind === 'agent' &&
            e.authorDisplayName === needs.bAgent.display &&
            e.text.includes('should wait')
        ),
        'B’s agent did not answer past the limit'
      );
      assert.equal((await probe()).dispatchesSinceBoot, dispatched, 'B’s computer started no turn');
      const historyShot = await shot(a.page, '22c-2-desktop-a-post-kept-as-history');

      // B clears the limit again, so the rest of the journey runs as before.
      const cleared = await json<Spend>(spendPath, sendJson('PUT', { monthlyLimitUsd: null }));
      assert.equal(cleared.monthlyLimitUsd, null);
      return { spentUsd: before.spentUsd, blockShot, historyShot };
    }
  );
}
