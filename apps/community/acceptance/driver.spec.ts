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
    const memberA = await browser.newContext();
    const pageA = await ownerA.newPage();
    const pageB = await ownerB.newPage();
    const pageMemberA = await memberA.newPage();
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

      // The person who addresses the agent must be a distinct, browser-admitted
      // member of Community A. Community B exists to prove that pairing identities
      // stay isolated; it is not the second participant in A's shared channel.
      await pageA.getByRole('button', { name: 'Manage' }).click();
      await pageA.getByRole('button', { name: 'Create invite' }).click();
      const inviteUrl = await pageA.getByLabel('One-time invite link').inputValue();
      await pageMemberA.goto(inviteUrl);
      await pageMemberA.getByRole('button', { name: 'Continue' }).click();
      await pageMemberA.getByRole('button', { name: 'Create account' }).click();
      await pageMemberA.getByLabel('Your name').fill('Casey Member');
      await pageMemberA.getByLabel('Email').fill('casey@acceptance.test');
      await pageMemberA.getByLabel('Password').fill('acceptance-password');
      await pageMemberA.getByRole('button', { name: 'Join community' }).click();
      await expect(pageMemberA.getByLabel(/Message #general/i)).toBeVisible();

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

      const agentPath = join(env.root, 'agents', 'community-attachment-agent');
      const registered = await json<{ id: string; name: string }>(`${env.local}/api/mesh/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: agentPath,
          scanRoot: join(env.root, 'agents'),
          overrides: {
            name: 'Attachment Agent',
            runtime: 'claude-code',
            behavior: { responseMode: 'silent' },
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

      const composer = pageMemberA.getByLabel(/Message #general/i);
      await expect(composer).toBeVisible();
      await composer.fill(`@${handle} show the packaged proof`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();

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
      const memberConfirmed = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageMemberA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) =>
            page.entries.filter((entry) => entry.authorDisplayName === registered.name)
          ),
        (entries) => entries.length === 1 && entries[0]?.id === confirmed[0]?.id,
        'the confirmed remote reply was not visible to the invited Community A member'
      );
      expect(memberConfirmed).toHaveLength(1);
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
        () =>
          json<{ connection: { status: string } | null }>(`${env.local}/api/communities/${refA}`),
        (result) => result.connection?.status === 'connected',
        'the packaged local server did not reconnect to Community A after restart'
      );
      const localTurns = () =>
        json<{ sessions: Array<{ id: string }> }>(
          `${env.local}/api/sessions?cwd=${encodeURIComponent(agentPath)}`
        ).then((result) => result.sessions);
      const beforeFreshMention = await eventually(
        localTurns,
        (sessions) => sessions.length === 0,
        'the restarted local server replayed a historical Community entry into an agent turn'
      );
      expect(beforeFreshMention).toHaveLength(0);

      // A fresh live entry makes the recovered subscription observable. Exactly
      // two replies means this addressed post ran once and the historical first
      // post did not run again while the local server restarted.
      const restartScenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'rooms-post-attachment' },
      });
      expect(
        restartScenario.ok(),
        `could not restore test runtime scenario after restart: ${await restartScenario.text()}`
      ).toBe(true);
      await composer.fill(`@${handle} prove the recovered live subscription`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();
      const freshTurns = await eventually(
        localTurns,
        (sessions) => sessions.length === 1,
        'the fresh addressed Community entry did not run exactly one local agent turn'
      );
      expect(freshTurns).toHaveLength(1);
      const afterRestart = await eventually(
        agentEntries,
        (entries) =>
          entries.length === 2 &&
          entries.every(
            (entry) =>
              entry.text === 'Here is what I saw.' &&
              entry.attachments.length === 1 &&
              entry.attachments[0]?.name === 'shot.png'
          ),
        'restart did not preserve a live Community subscription without replaying history'
      );
      expect(afterRestart).toHaveLength(2);
    } finally {
      await ownerA.close();
      await ownerB.close();
      await memberA.close();
    }
  });
});
