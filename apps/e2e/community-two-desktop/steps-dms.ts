import assert from 'node:assert/strict';
import { expect, type Locator } from '@playwright/test';
import { channelEntries, composer, feed, send, type Desktop } from './desktop.js';
import type { Entry, World } from './world.js';

/**
 * Step 22b: a direct message with another member's agent (DOR-2955). B turns direct messages on
 * for B's agent from B's app, A opens one from the agent's row in #general and asks it something,
 * B's computer answers through the scripted test runtime (no model, no spend), and B reads the
 * conversation read-only, without a composer.
 *
 * @module community-two-desktop/steps-dms
 */

/** What step 22b needs from the agent steps around it. */
export interface DirectMessageStepNeeds {
  /** B's enrolled agent: its local id, its name in the space, and its member id there. */
  bAgent: { id: string; display?: string; memberId?: string };
  /** Open a channel with the Members panel showing the agent controls. */
  openAgents: (local: Desktop, ref: string, roomId: string) => Promise<void>;
  /** The "Your agents in this space" region. */
  agentsRegion: (local: Desktop) => Locator;
}

/**
 * Run step 22b.
 *
 * @param w - The journey so far.
 * @param needs - B's agent and the agent-panel helpers from the agent steps.
 */
export async function directMessageStep(w: World, needs: DirectMessageStepNeeds): Promise<void> {
  const { step, shot, a, b, refA, room, stamp } = w;
  const refB = w.refB;
  const { bAgent, openAgents, agentsRegion } = needs;
  const agentName = bAgent.display!;

  await step(
    '22b A messages B’s agent directly; B’s computer answers; B reads it, read-only',
    async () => {
      // B turns direct messages on for B's agent, from B's own app.
      await openAgents(b, refB, room.roomId);
      const card = agentsRegion(b).locator('div.rounded-md').filter({ hasText: agentName });
      const toggle = card.getByRole('switch', { name: 'Takes direct messages' });
      await expect(toggle).not.toBeChecked();
      const turnedOn = b.page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          new URL(r.url()).pathname ===
            `/api/communities/${refB}/agents/${encodeURIComponent(bAgent.id)}/dms`
      );
      await toggle.click();
      assert.equal((await turnedOn).status(), 200, 'B turns direct messages on');
      await expect(toggle).toBeChecked();
      const switchShot = await shot(b.page, '22b-1-desktop-b-takes-direct-messages');

      // A opens one from B's agent's row in #general's member list.
      await openAgents(a, refA, room.roomId);
      const message = a.page.getByRole('button', { name: `Message ${agentName}`, exact: true });
      await expect(message).toBeVisible({ timeout: 30_000 });
      const rosterShot = await shot(a.page, '22b-2-desktop-a-message-button');
      const started = a.page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === `/api/communities/${refA}/dms`
      );
      await message.click();
      const startResponse = await started;
      assert.equal(startResponse.status(), 200, 'A starts the direct message');
      const dmRoomId = ((await startResponse.json()) as { dm: { roomId: string } }).dm.roomId;
      w.communityRoomIds.push(dmRoomId);
      await expect(a.page).toHaveURL(new RegExp(`id=${dmRoomId}`));
      await expect(
        a.page.getByText(/’s agent · .+ can read this$/, { exact: false }).first()
      ).toBeVisible({ timeout: 30_000 });

      // B's app picks the conversation up for B's agent before A asks.
      await expect
        .poll(
          async () => {
            const r = await fetch(
              `${b.origin}/api/test/community-subscription?ref=${encodeURIComponent(refB)}&roomId=${encodeURIComponent(dmRoomId)}`
            );
            if (!r.ok) return false;
            const body = (await r.json()) as {
              snapshotComplete?: boolean;
              replayComplete?: boolean;
            };
            return Boolean(body.snapshotComplete && body.replayComplete);
          },
          { timeout: 60_000 }
        )
        .toBe(true);

      // No mention: everything A says here is to the agent.
      const ask = `please confirm the direct message ${stamp}`;
      await send(composer(a), ask);
      let reply: Entry | undefined;
      await expect
        .poll(
          async () => {
            reply = (await channelEntries<Entry>(a, refA, dmRoomId)).find(
              (e) =>
                e.authorKind === 'agent' &&
                e.authorDisplayName === agentName &&
                e.text.startsWith('Echo:')
            );
            return Boolean(reply);
          },
          { timeout: 90_000 }
        )
        .toBe(true);
      assert(reply!.text.includes(stamp), 'the reply answers this run’s direct message');
      await expect(
        feed(a).getByText(reply!.text.slice(0, 40), { exact: false }).first()
      ).toBeVisible({
        timeout: 30_000,
      });
      const dmShot = await shot(a.page, '22b-3-desktop-a-direct-message');

      // B, the agent's owner, reads it read-only: both messages, no composer.
      await b.page.goto(`${b.origin}/channels?community=${refB}&id=${dmRoomId}`);
      await expect(b.page.getByText('Read-only', { exact: false }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(b.page.getByText(ask, { exact: false }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        b.page.getByText(reply!.text.slice(0, 40), { exact: false }).first()
      ).toBeVisible();
      await expect(composer(b)).toHaveCount(0);
      return {
        dmRoomId,
        reply: reply!.text.slice(0, 160),
        switchShot,
        rosterShot,
        dmShot,
        readOnlyShot: await shot(b.page, '22b-4-desktop-b-read-only'),
      };
    }
  );
}
