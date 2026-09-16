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
  }, testInfo) => {
    const env = acceptanceEnvironment();
    const ownerA = await browser.newContext();
    const ownerB = await browser.newContext();
    const memberA = await browser.newContext();
    const localContext = await browser.newContext();
    const localPage = await localContext.newPage();
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
      await pageA.locator('#invite-channel').selectOption({ label: '#general' });
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
          `${env.local}/api/community-connections`,
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
              `${env.local}/api/community-connections/${started.connection.ref}/poll`,
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

      type SubscriptionBarrier = {
        generation: number;
        snapshotComplete: boolean;
        replayComplete: boolean;
        dispatchesSinceBoot: number;
      };
      const subscriptionBarrier = async (): Promise<SubscriptionBarrier | null> => {
        const response = await fetch(
          `${env.local}/api/test/community-subscription?ref=${encodeURIComponent(refA)}&roomId=${encodeURIComponent(roomA!.roomId)}`
        );
        // Restarting the packaged server makes the runtime probe briefly absent
        // before the first subscription is constructed. That is a not-ready
        // condition for this poll, rather than evidence that replay completed.
        if (response.status === 404 || response.status === 503) return null;
        if (!response.ok) {
          throw new Error(
            `GET /api/test/community-subscription returned ${response.status}: ${await response.text()}`
          );
        }
        return (await response.json()) as SubscriptionBarrier;
      };

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

      const ready = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'the enrolled local agent did not finish its initial room subscription'
      );
      expect(ready?.dispatchesSinceBoot).toBe(0);

      const scenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'rooms-post-attachment' },
      });
      expect(
        scenario.ok(),
        `could not select test runtime scenario: ${await scenario.text()}`
      ).toBe(true);
      expect(await scenario.json()).toMatchObject({ scenario: 'rooms-post-attachment' });

      const localConfig = await json<{ dorkHome: string }>(`${env.local}/api/config`);
      expect(localConfig.dorkHome).toBe(join(env.root, 'local-home'));
      const now = new Date().toISOString();
      await json(`${env.local}/api/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          onboarding: { dismissedAt: now },
          profile: { rolePromptDismissedAt: now },
          telemetry: { userHasDecided: true },
          ui: { fullPowerDecidedAt: now, fullPowerChoice: 'supervised' },
        }),
      });
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(
        localPage.getByRole('button', { name: 'Stop my agents', exact: true })
      ).toBeVisible();
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'arm', channelId: roomA!.roomId, phase: 'before-persist' }),
      });

      const composer = pageMemberA.getByLabel(/Message #general/i);
      await expect(composer).toBeVisible();
      await composer.fill(`@${handle} show the packaged proof`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();

      await eventually(
        () => json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`),
        (gate) => gate.state === 'held-before-persist',
        'the actual local agent never reached the pre-persistence delivery gate'
      );
      // The agent answers the triggering message in its thread. Inspect that
      // same thread for both the pending delivery and its confirmed replacement.
      await localPage.getByRole('button', { name: 'Reply in thread', exact: true }).click();
      await expect(localPage.getByRole('feed', { name: 'Community thread' })).toBeVisible();
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toBeVisible();
      const heldHistory = await pageJson<{ entries: Array<{ authorDisplayName: string }> }>(
        pageA,
        `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
      );
      expect(
        heldHistory.entries.filter((entry) => entry.authorDisplayName === registered.name)
      ).toHaveLength(0);
      await localPage.screenshot({
        path: testInfo.outputPath('native-pending-desktop.png'),
        fullPage: true,
      });
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      });

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
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toHaveCount(0);
      await expect(localPage.getByText('Here is what I saw.', { exact: true })).toHaveCount(1);
      for (const viewport of [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'tablet', width: 820, height: 1180 },
        { name: 'mobile', width: 390, height: 844 },
      ]) {
        await localPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await localPage.emulateMedia({
          colorScheme: viewport.name === 'tablet' ? 'dark' : 'light',
        });
        await expect(
          localPage.getByRole('button', { name: 'Stop my agents', exact: true })
        ).toBeVisible();
        expect(
          await localPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        await localPage.screenshot({
          path: testInfo.outputPath(`native-confirmed-${viewport.name}.png`),
          fullPage: true,
        });
      }

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

      // Restart the remote Community itself before restarting the local process.
      // Both browser contexts keep their authenticated identities, while the
      // exact confirmed receipt and its attachment must survive a fresh server.
      const restartCommunityA = await request.post(`${env.control}/restart/a`);
      expect(
        restartCommunityA.ok(),
        `could not restart packaged Community A: ${await restartCommunityA.text()}`
      ).toBe(true);
      const restartedOwnerEntries = await eventually(
        agentEntries,
        (entries) => entries.length === 1 && entries[0]?.id === confirmed[0]?.id,
        "Community A restart did not retain the owner's exact confirmed receipt"
      );
      const restartedMemberEntries = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageMemberA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) =>
            page.entries.filter((entry) => entry.authorDisplayName === registered.name)
          ),
        (entries) => entries.length === 1 && entries[0]?.id === confirmed[0]?.id,
        "Community A restart did not retain the member's exact confirmed receipt"
      );
      expect(restartedOwnerEntries[0]?.attachments[0]?.id).toBe(confirmed[0]?.attachments[0]?.id);
      expect(restartedMemberEntries[0]?.attachments[0]?.id).toBe(confirmed[0]?.attachments[0]?.id);
      const restartedPng = await pageA.evaluate(async (attachmentId) => {
        const response = await fetch(`/api/v1/attachments/${attachmentId}`);
        if (!response.ok) throw new Error(`attachment download returned ${response.status}`);
        return Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8));
      }, confirmed[0]!.attachments[0]!.id);
      expect(Buffer.from(restartedPng).subarray(1, 4).toString('latin1')).toBe('PNG');
      const localRetainedReceipt = await eventually(
        () =>
          json<{ entries: Entry[] }>(
            `${env.local}/api/communities/${refA}/rooms/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.filter((entry) => entry.id === confirmed[0]?.id)),
        (entries) => entries.length === 1,
        'the native Community A connection was not usable after the remote restart'
      );
      expect(localRetainedReceipt[0]?.attachments[0]?.id).toBe(confirmed[0]?.attachments[0]?.id);

      const finish = await request.post(`${env.local}/api/test/finish-turn`);
      expect(finish.ok(), `could not finish deterministic turn: ${await finish.text()}`).toBe(true);
      const restart = await request.post(`${env.control}/restart/local`);
      expect(restart.ok(), `could not restart packaged local server: ${await restart.text()}`).toBe(
        true
      );
      await eventually(
        () =>
          json<{ connection: { status: string } | null }>(
            `${env.local}/api/community-connections/${refA}`
          ),
        (result) => result.connection?.status === 'connected',
        'the packaged local server did not reconnect to Community A after restart'
      );
      // A connected pairing only proves authentication. This test-only, runtime-owned
      // barrier is recorded after the bridge imports its snapshot and consumes every
      // server entry through the captured replay watermark. It makes the zero below a
      // post-replay assertion rather than a race with the subscription startup.
      const recovered = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'the restarted local server did not finish importing the Community subscription replay'
      );
      expect(recovered?.dispatchesSinceBoot).toBe(0);
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
      const afterFreshMention = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.dispatchesSinceBoot === 1,
        'the fresh addressed Community entry did not produce exactly one dispatcher claim'
      );
      expect(afterFreshMention?.dispatchesSinceBoot).toBe(1);
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

      // Community B is a separate packaged server and has no local agent
      // enrollment. Its human post must stay in B's qualified route and leave
      // Community A's live dispatcher count unchanged.
      const roomsB = await json<{ rooms: Array<{ roomId: string; title: string }> }>(
        `${env.local}/api/communities/${refB}/rooms`
      );
      const roomB = roomsB.rooms.find(
        (room) => room.title === 'General' || room.title === 'general'
      );
      expect(roomB, 'the browser-created Community B channel was not visible locally').toBeTruthy();
      const readyBeforeB = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready before the isolated Community B post'
      );
      const dispatchesBeforeB = readyBeforeB!.dispatchesSinceBoot;
      const bMarker = `B-only-${crypto.randomUUID()}`;
      await pageB.getByLabel(/Message #general/i).fill(bMarker);
      await pageB.getByRole('button', { name: 'Send' }).click();
      await eventually(
        () =>
          pageJson<{ entries: Array<{ text: string }> }>(
            pageB,
            `/api/v1/channels/${roomB!.roomId}/entries?limit=100`
          ),
        (page) => page.entries.some((entry) => entry.text === bMarker),
        'the Community B human post did not commit'
      );
      const localBHistory = await eventually(
        () =>
          json<{ entries: Array<{ text: string }> }>(
            `${env.local}/api/communities/${refB}/rooms/${roomB!.roomId}/entries?limit=100`
          ),
        (page) => page.entries.some((entry) => entry.text === bMarker),
        'the qualified local Community B history did not contain its human post'
      );
      expect(localBHistory.entries.some((entry) => entry.text === bMarker)).toBe(true);
      const localAHistory = await json<{ entries: Array<{ text: string }> }>(
        `${env.local}/api/communities/${refA}/rooms/${roomA!.roomId}/entries?limit=100`
      );
      expect(localAHistory.entries.some((entry) => entry.text === bMarker)).toBe(false);
      const bProbe = await fetch(
        `${env.local}/api/test/community-subscription?ref=${encodeURIComponent(refB)}&roomId=${encodeURIComponent(roomB!.roomId)}`
      );
      expect(bProbe.status).toBe(404);
      const readyAfterB = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready after the isolated Community B post'
      );
      expect(readyAfterB?.dispatchesSinceBoot).toBe(dispatchesBeforeB);
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refB)}&id=${encodeURIComponent(roomB!.roomId)}`
      );
      await expect(localPage.getByText(bMarker, { exact: true })).toBeVisible();
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();
      await expect(localPage.getByText(bMarker, { exact: true })).toHaveCount(0);

      // The runner owns both lifecycle controls and keeps Community A's database,
      // credentials, and browser sessions intact. The local UI must report an
      // offline stream and reconnect after that same server comes back.
      const stopCommunityA = await request.post(`${env.control}/stop/a`);
      expect(
        stopCommunityA.ok(),
        `could not stop packaged Community A: ${await stopCommunityA.text()}`
      ).toBe(true);
      const offlineNotice = localPage.getByText('Connection lost. Showing saved messages.', {
        exact: true,
      });
      await expect(offlineNotice).toBeVisible({ timeout: 90_000 });
      const startCommunityA = await request.post(`${env.control}/start/a`);
      expect(
        startCommunityA.ok(),
        `could not start packaged Community A: ${await startCommunityA.text()}`
      ).toBe(true);
      await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'the local Community A subscription did not finish replay after its remote server restarted'
      );
      await expect(offlineNotice).toHaveCount(0, { timeout: 90_000 });
      await expect(localPage.getByText(bMarker, { exact: true })).toHaveCount(0);

      // A transient remote failure must surface a retryable pending delivery.
      // The manual retry is clicked while the Community keeps answering 503, so
      // the observed second attempt is caused by the UI action rather than the
      // worker's regular backoff. Releasing then proves idempotent confirmation.
      const retryMarker = `retry-now-${crypto.randomUUID()}`;
      const entriesBeforeRetry = await agentEntries();
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'arm', channelId: roomA!.roomId, phase: 'unavailable' }),
      });
      await composer.fill(`@${handle} ${retryMarker}`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();
      const retryRoot = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageMemberA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) =>
            page.entries.find((entry) => entry.text === `@${handle} ${retryMarker}`)
          ),
        (entry) => entry !== undefined,
        'the retryable Community A trigger did not commit'
      );
      const unavailable = await eventually(
        () =>
          json<{ state: string; attempts: number }>(
            `${env.communityA}/api/test/delivery-receipt-gate`
          ),
        (gate) => gate.state === 'unavailable' && gate.attempts >= 1,
        'the unavailable Community gate did not observe the first agent delivery attempt'
      );
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}&thread=${encodeURIComponent(retryRoot!.id)}`
      );
      const retryNow = localPage.getByRole('button', { name: 'Retry now', exact: true });
      await expect(retryNow).toBeVisible({ timeout: 90_000 });
      await localPage.screenshot({
        path: testInfo.outputPath('native-retryable-delivery.png'),
        fullPage: true,
      });
      const retryResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.includes(
            `/api/communities/${refA}/rooms/${roomA!.roomId}/deliveries/`
          ) &&
          new URL(response.url()).pathname.endsWith('/retry')
      );
      await retryNow.click();
      const retryResult = await retryResponse;
      expect(retryResult.ok(), `Retry now returned ${retryResult.status()}`).toBe(true);
      const retriedUnavailable = await eventually(
        () =>
          json<{ state: string; attempts: number }>(
            `${env.communityA}/api/test/delivery-receipt-gate`
          ),
        (gate) => gate.state === 'unavailable' && gate.attempts >= unavailable.attempts + 1,
        'Retry now did not cause a second remote delivery attempt'
      );
      expect(retriedUnavailable.attempts).toBeGreaterThan(unavailable.attempts);
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      });
      const retryConfirmed = await eventually(
        agentEntries,
        (entries) => entries.length === entriesBeforeRetry.length + 1,
        'the released retryable delivery did not produce exactly one confirmed entry'
      );
      expect(retryConfirmed.at(-1)?.text).toBe('Here is what I saw.');
      await expect(retryNow).toHaveCount(0);
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();

      // A committed Community event can outlive its HTTP receipt. Its native
      // SSE echo must replace the pending row by exact remote entry identity,
      // so this thread contains one agent reply before, during, and after the
      // held receipt rather than a timed duplicate.
      const afterPersistMarker = `after-persist-${crypto.randomUUID()}`;
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'arm', channelId: roomA!.roomId, phase: 'after-persist' }),
      });
      await composer.fill(`@${handle} ${afterPersistMarker}`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();
      const afterPersistRoot = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageMemberA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) =>
            page.entries.find((entry) => entry.text === `@${handle} ${afterPersistMarker}`)
          ),
        (entry) => entry !== undefined,
        'the after-persist Community A trigger did not commit'
      );
      const heldAfterPersist = await eventually(
        () =>
          json<{ state: string; entryId?: string }>(
            `${env.communityA}/api/test/delivery-receipt-gate`
          ),
        (gate) => gate.state === 'held' && typeof gate.entryId === 'string',
        'the Community receipt was not held after persistence'
      );
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}&thread=${encodeURIComponent(afterPersistRoot!.id)}`
      );
      const afterPersistThread = localPage.getByRole('feed', { name: 'Community thread' });
      await expect(
        afterPersistThread.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(1);
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toHaveCount(0);
      await expect(afterPersistThread.getByText(afterPersistMarker, { exact: true })).toHaveCount(
        1
      );
      const heldEntryId = heldAfterPersist.entryId!;
      const heldRemoteEntry = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.filter((entry) => entry.id === heldEntryId)),
        (entries) => entries.length === 1,
        'the held post-persistence receipt did not name exactly one remote entry'
      );
      expect(heldRemoteEntry[0]?.text).toBe('Here is what I saw.');
      await localPage.screenshot({
        path: testInfo.outputPath('native-held-after-persist-receipt.png'),
        fullPage: true,
      });
      await localPage.reload();
      await expect(
        afterPersistThread.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(1);
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toHaveCount(0);
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      });
      await eventually(
        () => json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`),
        (gate) => gate.state === 'idle',
        'the post-persistence receipt did not settle after release'
      );
      await expect(
        afterPersistThread.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(1);
      const releasedRemoteEntry = await pageJson<{ entries: Entry[] }>(
        pageA,
        `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
      );
      expect(releasedRemoteEntry.entries.filter((entry) => entry.id === heldEntryId)).toHaveLength(
        1
      );
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();

      // A real runtime turn waits on its session-scoped step barrier. The Stop
      // button must terminate it before the barrier can release, proving Stop
      // does more than hide a later remote delivery.
      const stoppableScenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'stoppable-turn' },
      });
      expect(
        stoppableScenario.ok(),
        `could not select the stoppable-turn scenario: ${await stoppableScenario.text()}`
      ).toBe(true);
      const sessionIdsBeforeStop = new Set((await localTurns()).map((session) => session.id));
      const readyBeforeStop = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready before the live Stop journey'
      );
      await composer.fill(`@${handle} stop-marker-${crypto.randomUUID()}`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();
      await eventually(
        subscriptionBarrier,
        (result) =>
          result !== null &&
          result.dispatchesSinceBoot === readyBeforeStop!.dispatchesSinceBoot + 1,
        'the live stoppable turn did not receive a dispatcher claim'
      );
      const stoppableSession = await eventually(
        localTurns,
        (sessions) =>
          sessions.find((session) => !sessionIdsBeforeStop.has(session.id)) !== undefined,
        'the live stoppable turn never created a local runtime session'
      );
      const stoppableSessionId = stoppableSession.find(
        (session) => !sessionIdsBeforeStop.has(session.id)
      )!.id;
      const stopResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/halt`
      );
      await localPage.getByRole('button', { name: 'Stop my agents', exact: true }).click();
      const stopResult = await stopResponse;
      expect(stopResult.ok(), `live Stop returned ${stopResult.status()}`).toBe(true);
      await expect(stopResult.json()).resolves.toEqual({ stopped: true });
      const stoppedStep = await json<{ ok: boolean; released: boolean }>(
        `${env.local}/api/test/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: stoppableSessionId }),
        }
      );
      expect(stoppedStep).toEqual({ ok: true, released: false });
      expect((await agentEntries()).some((entry) => entry.text.includes('STOPPABLE-TURN'))).toBe(
        false
      );

      const restoredAttachmentScenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'rooms-post-attachment' },
      });
      expect(
        restoredAttachmentScenario.ok(),
        `could not restore attachment scenario after Stop: ${await restoredAttachmentScenario.text()}`
      ).toBe(true);
      const holdAttachmentDelivery = async (marker: string) => {
        const beforeEntries = await agentEntries();
        const beforeDispatch = await eventually(
          subscriptionBarrier,
          (result) => result !== null && result.snapshotComplete && result.replayComplete,
          `Community A subscription was not ready before ${marker}`
        );
        await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'arm',
            channelId: roomA!.roomId,
            phase: 'before-persist',
          }),
        });
        await composer.fill(`@${handle} ${marker}`);
        await pageMemberA.getByRole('button', { name: 'Send' }).click();
        await eventually(
          subscriptionBarrier,
          (result) =>
            result !== null &&
            result.dispatchesSinceBoot === beforeDispatch!.dispatchesSinceBoot + 1,
          `${marker} did not receive a dispatcher claim before persistence`
        );
        await eventually(
          () => json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`),
          (gate) => gate.state === 'held-before-persist',
          `${marker} never reached the pre-persistence receipt gate`
        );
        expect(await agentEntries()).toHaveLength(beforeEntries.length);
        return beforeEntries.length;
      };

      const beforeHeldStop = await holdAttachmentDelivery(`held-stop-${crypto.randomUUID()}`);
      const heldStopResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/halt`
      );
      await localPage.getByRole('button', { name: 'Stop my agents', exact: true }).click();
      const heldStopResult = await heldStopResponse;
      expect(heldStopResult.ok(), `held-delivery Stop returned ${heldStopResult.status()}`).toBe(
        true
      );
      await eventually(
        () => json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`),
        (gate) => gate.state === 'idle',
        'Stop did not abort the held pre-persistence Community delivery'
      );
      expect(await agentEntries()).toHaveLength(beforeHeldStop);

      const beforeEjection = await holdAttachmentDelivery(`held-ejection-${crypto.randomUUID()}`);
      await localPage.getByRole('button', { name: 'Members', exact: true }).click();
      await expect(localPage.getByText(registered.name, { exact: true })).toBeVisible();
      const ejectionResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/agents/${encodeURIComponent(localAgentId)}`
      );
      await localPage.getByRole('button', { name: 'Remove from community', exact: true }).click();
      await localPage.getByRole('button', { name: 'Remove agent', exact: true }).click();
      const ejectionResult = await ejectionResponse;
      expect(ejectionResult.ok(), `agent ejection returned ${ejectionResult.status()}`).toBe(true);
      await expect(ejectionResult.json()).resolves.toMatchObject({
        localRevoked: true,
        remoteRevoked: true,
      });
      await eventually(
        () => json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`),
        (gate) => gate.state === 'idle',
        'agent ejection did not abort the held pre-persistence Community delivery'
      );
      expect(await agentEntries()).toHaveLength(beforeEjection);
      const remainingEnrollment = await eventually(
        () =>
          json<{ agents: Array<{ localAgentId: string }> }>(
            `${env.local}/api/communities/${refA}/agents`
          ),
        (result) => result.agents.every((agent) => agent.localAgentId !== localAgentId),
        'the ejected agent remained locally enrolled in Community A'
      );
      expect(remainingEnrollment.agents).not.toContainEqual(
        expect.objectContaining({ localAgentId })
      );
      await expect(
        localPage.getByText('You no longer have access to this channel.', { exact: true })
      ).toBeVisible();
    } finally {
      await ownerA.close();
      await ownerB.close();
      await memberA.close();
      await localContext.close();
    }
  });
});
