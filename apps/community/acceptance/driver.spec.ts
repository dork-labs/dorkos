/**
 * Sealed end-to-end proof for the packaged Community/local-agent path.
 *
 * This intentionally uses only built Community browser pages plus the public
 * local DorkOS HTTP surface. The deterministic runtime scenario is selected
 * through its test-control endpoint, then the real dispatcher, capability,
 * outbox, native adapter, and remote server do the work.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  acceptanceEnvironment,
  bootstrapCommunity,
  eventually,
  json,
  pageJson,
} from './helpers.js';

test.describe('Packaged Community local-agent proof @integration', () => {
  test('pairs two built communities and confirms one real agent attachment reply', async ({
    browser,
    request,
  }) => {
    const env = acceptanceEnvironment();
    const ownerA = await browser.newContext();
    const ownerB = await browser.newContext();
    const pageA = await ownerA.newPage();
    const pageB = await ownerB.newPage();
    try {
      await bootstrapCommunity(pageA, {
        url: env.communityA,
        secret: env.communityASecret,
        name: 'Ada Owner',
        email: 'ada@acceptance.test',
        community: 'Acceptance A',
      });
      await bootstrapCommunity(pageB, {
        url: env.communityB,
        secret: env.communityBSecret,
        name: 'Bea Owner',
        email: 'bea@acceptance.test',
        community: 'Acceptance B',
      });

      const connect = async (origin: string, page: typeof pageA, name: string) => {
        const started = await json<{ connection: { ref: string }; approvalUrl: string }>(
          `${env.local}/api/communities`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: origin, installName: name }),
          }
        );
        await page.goto(started.approvalUrl);
        await expect(page.getByRole('heading', { name: 'Connect a local install' })).toBeVisible();
        await page.getByRole('button', { name: 'Approve connection' }).click();
        await expect(page.getByRole('status')).toContainText('Approved');
        const connected = await eventually(
          () =>
            json<{ status: string; connection: { ref: string } | null }>(
              `${env.local}/api/communities/${started.connection.ref}/poll`,
              { method: 'POST' }
            ),
          (result) => result.status === 'connected' && result.connection !== null,
          `local pairing to ${origin} did not complete`
        );
        return connected.connection!.ref;
      };

      const refA = await connect(env.communityA, pageA, 'Acceptance local install A');
      const refB = await connect(env.communityB, pageB, 'Acceptance local install B');
      expect(refA).not.toBe(refB);

      const roomsA = await json<{ rooms: Array<{ roomId: string; title: string }> }>(
        `${env.local}/api/communities/${refA}/rooms`
      );
      const roomA = roomsA.rooms.find(
        (room) => room.title === 'General' || room.title === 'general'
      );
      expect(
        roomA,
        'the browser-created general channel was not visible to the native connection'
      ).toBeTruthy();

      const registered = await json<{ id: string; name: string }>(`${env.local}/api/mesh/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: join(env.root, 'agents', 'community-attachment-agent'),
          scanRoot: join(env.root, 'agents'),
          overrides: {
            name: 'Attachment Agent',
            runtime: 'claude-code',
            behavior: 'silent',
          },
        }),
      });
      const localAgentId = registered.id;
      const handle = 'attachment-agent';
      await json(
        `${env.local}/api/communities/${refA}/agents/${encodeURIComponent(localAgentId)}/enroll`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle }),
        }
      );
      const joined = await fetch(
        `${env.local}/api/communities/${refA}/rooms/${roomA!.roomId}/agents/${encodeURIComponent(localAgentId)}/membership`,
        { method: 'POST' }
      );
      expect(joined.status).toBe(204);

      const scenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'rooms-post-attachment' },
      });
      expect(
        scenario.ok(),
        `could not select test runtime scenario: ${await scenario.text()}`
      ).toBe(true);
      expect(await scenario.json()).toMatchObject({ scenario: 'rooms-post-attachment' });

      await pageA.goto(`${env.communityA}/`);
      const composer = pageA.getByLabel(/Message #general/i);
      await expect(composer).toBeVisible();
      await composer.fill(`@${handle} show the packaged proof`);
      await pageA.getByRole('button', { name: 'Send' }).click();

      type Entry = {
        id: string;
        text: string;
        authorDisplayName: string;
        attachments: Array<{ id: string; name: string }>;
      };
      const agentEntries = () =>
        pageJson<{ entries: Entry[] }>(
          pageA,
          `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
        ).then((page) =>
          page.entries.filter((entry) => entry.authorDisplayName === registered.name)
        );
      const confirmed = await eventually(
        agentEntries,
        (entries) =>
          entries.length === 1 &&
          entries[0]?.text === 'Here is what I saw.' &&
          entries[0]?.attachments.length === 1 &&
          entries[0]?.attachments[0]?.name === 'shot.png',
        'the real local dispatcher/outbox did not produce exactly one remote agent attachment entry'
      );
      expect(confirmed).toHaveLength(1);
      const png = await pageA.evaluate(async (attachmentId) => {
        const response = await fetch(`/api/v1/attachments/${attachmentId}`);
        if (!response.ok) throw new Error(`attachment download returned ${response.status}`);
        return Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8));
      }, confirmed[0]!.attachments[0]!.id);
      expect(Buffer.from(png).subarray(1, 4).toString('latin1')).toBe('PNG');
      const allEntries = await pageJson<{ entries: Entry[] }>(
        pageA,
        `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
      );
      expect(allEntries.entries.map((entry) => entry.text).join('\n')).not.toContain(
        'POSTED-ATTACHMENT'
      );

      const finish = await request.post(`${env.local}/api/test/finish-turn`);
      expect(finish.ok(), `could not finish deterministic turn: ${await finish.text()}`).toBe(true);
      const restart = await request.post(`${env.control}/restart/local`);
      expect(restart.ok(), `could not restart packaged local server: ${await restart.text()}`).toBe(
        true
      );
      await eventually(
        agentEntries,
        (entries) => entries.length === 1,
        'local restart replayed a historical Community entry into a second agent turn'
      );
    } finally {
      await ownerA.close();
      await ownerB.close();
    }
  });
});
