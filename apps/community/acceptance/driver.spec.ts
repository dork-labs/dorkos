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
    const localContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: {
        dir: testInfo.outputPath('local-video'),
        size: { width: 1440, height: 900 },
      },
    });
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
      const enrollment = await json<{
        agent: { remoteMemberId: string; displayName: string };
      }>(`${env.local}/api/communities/${refA}/agents/${encodeURIComponent(localAgentId)}/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
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
      // The scenario uses rooms.post without replyTo, so its pending and
      // confirmed attachment rows belong to the channel feed.
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toBeVisible();
      type Entry = {
        id: string;
        text: string;
        authorMemberId: string;
        authorKind: 'agent' | 'human';
        authorDisplayName: string;
        originIdempotencyKey: string | null;
        parentEntryId: string | null;
        threadRootEntryId: string | null;
        attachments: Array<{ id: string; name: string }>;
      };
      const isEnrolledAgentEntry = (entry: Pick<Entry, 'authorMemberId' | 'authorKind'>) =>
        entry.authorKind === 'agent' && entry.authorMemberId === enrollment.agent.remoteMemberId;
      const heldHistory = await pageJson<{ entries: Entry[] }>(
        pageA,
        `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
      );
      expect(heldHistory.entries.filter(isEnrolledAgentEntry)).toHaveLength(0);
      await localPage.screenshot({
        path: testInfo.outputPath('native-pending-desktop.png'),
        fullPage: true,
      });
      await json(`${env.communityA}/api/test/delivery-receipt-gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      });

      const agentEntries = () =>
        pageJson<{ entries: Entry[] }>(
          pageA,
          `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
        ).then((page) => page.entries.filter(isEnrolledAgentEntry));
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
      // Read the attachment through the local browser surface. The remote-owner
      // fetch below only proves Community storage; this request proves the
      // qualified local authorization and Blob download path.
      const localAttachmentResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/attachments/${confirmed[0]!.attachments[0]!.id}`
      );
      const localAttachmentDownload = localPage.waitForEvent('download');
      await localPage.getByRole('button', { name: 'shot.png', exact: true }).click();
      const [attachmentResponse, attachmentDownload] = await Promise.all([
        localAttachmentResponse,
        localAttachmentDownload,
      ]);
      expect(attachmentResponse.ok()).toBe(true);
      expect(attachmentDownload.suggestedFilename()).toBe('shot.png');
      expect(
        Buffer.from(await attachmentResponse.body())
          .subarray(1, 4)
          .toString('latin1')
      ).toBe('PNG');
      for (const viewport of [
        { name: 'desktop', width: 1440, height: 900, dark: false },
        { name: 'tablet', width: 820, height: 1180, dark: true },
        { name: 'mobile', width: 390, height: 844, dark: false },
      ]) {
        await localPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await localPage.emulateMedia({ colorScheme: viewport.dark ? 'dark' : 'light' });
        await localPage.waitForFunction(
          ({ dark, foreground }) => {
            const root = document.documentElement;
            return (
              root.classList.contains('dark') === dark &&
              getComputedStyle(root).getPropertyValue('--foreground').trim() === foreground
            );
          },
          { dark: viewport.dark, foreground: viewport.dark ? '0 0% 87%' : '0 0% 9%' }
        );
        await localPage.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            )
        );
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
          ).then((page) => page.entries.filter(isEnrolledAgentEntry)),
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
      const beforeCommunityRestart = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready before its remote restart'
      );
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
          ).then((page) => page.entries.filter(isEnrolledAgentEntry)),
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
      const afterCommunityRestart = await eventually(
        subscriptionBarrier,
        (result) =>
          result !== null &&
          result.generation > beforeCommunityRestart!.generation &&
          result.snapshotComplete &&
          result.replayComplete,
        'Community A subscription did not establish a new completed generation after remote restart'
      );
      expect(afterCommunityRestart?.generation).toBeGreaterThan(beforeCommunityRestart!.generation);
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
      type SessionSpine = {
        lifecycle: string | null;
        /** Live projector position; completed-turn storage deliberately lags this. */
        seq: number | null;
        projectorLive: boolean;
        runtime: string | null;
        runtimeBound: boolean | null;
        durableEvents: { total: number; byType: Record<string, number> };
      };
      const sessionSpine = (sessionId: string) =>
        json<SessionSpine>(`${env.local}/api/debug/sessions/${encodeURIComponent(sessionId)}`);
      const turnEndCount = (session: SessionSpine) => session.durableEvents.byType.turn_end ?? 0;
      const waitForTurnToSettle = async (
        sessionId: string,
        priorTurnEnds: number,
        label: string
      ) => {
        const settled = await eventually(
          () => sessionSpine(sessionId),
          (session) => session.lifecycle === 'idle' && turnEndCount(session) > priorTurnEnds,
          label
        );
        expect(settled.lifecycle).toBe('idle');
        expect(turnEndCount(settled)).toBeGreaterThan(priorTurnEnds);
      };
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
      const recoveredTurnSessionId = freshTurns[0]!.id;
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

      // `rooms-post-attachment` deliberately remains open after its capability
      // call. End the recovered-subscription witness before beginning independent
      // delivery journeys: otherwise its single runtime slot queues the retry
      // attempt until the fixture's 60-second safety expiry. `finish-turn` is
      // sticky by design, so later attachment turns still exercise the real post
      // path but settle as soon as that post completes. The stoppable scenario
      // below has its own session-scoped barrier and remains live.
      const recoveredTurnBeforeFinish = await sessionSpine(recoveredTurnSessionId);
      expect(recoveredTurnBeforeFinish.lifecycle).toBe('streaming');
      const finishRecoveredTurn = await request.post(`${env.local}/api/test/finish-turn`);
      expect(
        finishRecoveredTurn.ok(),
        `could not finish recovered deterministic turn: ${await finishRecoveredTurn.text()}`
      ).toBe(true);
      await waitForTurnToSettle(
        recoveredTurnSessionId,
        turnEndCount(recoveredTurnBeforeFinish),
        'the recovered attachment turn did not settle before independent delivery journeys'
      );

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
      await pageB.goto(env.communityB);
      const bComposer = pageB.getByLabel(/Message #general/i);
      await expect(bComposer).toBeVisible({ timeout: 10_000 });
      await bComposer.fill(bMarker, { timeout: 10_000 });
      await pageB.getByRole('button', { name: 'Send' }).click({ timeout: 10_000 });
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
      const beforeOfflineRestart = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready before the controlled offline transition'
      );
      const stopCommunityA = await request.post(`${env.control}/stop/a`);
      expect(
        stopCommunityA.ok(),
        `could not stop packaged Community A: ${await stopCommunityA.text()}`
      ).toBe(true);
      const offlineNotice = localPage.getByText('Community unavailable. Showing saved messages.', {
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
        (result) =>
          result !== null &&
          result.generation > beforeOfflineRestart!.generation &&
          result.snapshotComplete &&
          result.replayComplete,
        'the local Community A subscription did not establish a new completed generation after its remote server restarted'
      );
      await expect(offlineNotice).toHaveCount(0, { timeout: 90_000 });
      await expect(localPage.getByText(bMarker, { exact: true })).toHaveCount(0);

      // A transient remote failure must surface a retryable pending delivery.
      // The atomic retry endpoint returns the owner-qualified replacement
      // snapshot while the Community keeps returning 503. Releasing then
      // proves that the original key confirms exactly once.
      const retryMarker = `retry-now-${crypto.randomUUID()}`;
      const retryTurnBeforeStart = await sessionSpine(recoveredTurnSessionId);
      expect(retryTurnBeforeStart.lifecycle).toBe('idle');
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
      await eventually(
        () =>
          json<{ state: string; attempts: number }>(
            `${env.communityA}/api/test/delivery-receipt-gate`
          ),
        (gate) => gate.state === 'unavailable' && gate.attempts >= 1,
        'the unavailable Community gate did not observe the first agent delivery attempt'
      );
      expect(retryRoot?.id).toBeTruthy();
      const retryNow = localPage.getByRole('button', { name: 'Retry now', exact: true });
      // This control only renders for a pending delivery whose next retry is
      // still in the future.
      await expect(retryNow).toBeVisible({ timeout: 90_000 });
      await expect(retryNow).toBeEnabled();
      expect(
        await json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`)
      ).toMatchObject({ state: 'unavailable' });
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
      const retryIdempotencyKey = decodeURIComponent(
        new URL(retryResult.url()).pathname.split('/').at(-2)!
      );
      const retrySnapshot = (await retryResult.json()) as {
        community: string;
        roomId: string;
        deliveries: Array<{ idempotencyKey: string; state: string; retryable?: boolean }>;
      };
      expect(retrySnapshot).toMatchObject({ community: refA, roomId: roomA!.roomId });
      expect(
        retrySnapshot.deliveries.find((delivery) => delivery.idempotencyKey === retryIdempotencyKey)
      ).toMatchObject({ state: 'pending', retryable: false });
      expect(
        await json<{ state: string }>(`${env.communityA}/api/test/delivery-receipt-gate`)
      ).toMatchObject({ state: 'unavailable' });
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
      expect(
        retryConfirmed.filter((entry) => entry.originIdempotencyKey === retryIdempotencyKey)
      ).toHaveLength(1);
      await waitForTurnToSettle(
        recoveredTurnSessionId,
        turnEndCount(retryTurnBeforeStart),
        'the retryable attachment turn did not settle before the after-persistence delivery'
      );
      await expect(retryNow).toHaveCount(0);
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();

      // A committed Community event can outlive its HTTP receipt. Its native
      // SSE echo must replace the top-level pending row by exact remote entry
      // identity, so the channel count increases once rather than by a timer.
      const afterPersistMarker = `after-persist-${crypto.randomUUID()}`;
      const afterPersistTurnBeforeStart = await sessionSpine(recoveredTurnSessionId);
      expect(afterPersistTurnBeforeStart.lifecycle).toBe('idle');
      const entriesBeforeAfterPersist = await agentEntries();
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
      expect(afterPersistRoot?.id).toBeTruthy();
      const afterPersistChannel = localPage.getByRole('feed', { name: 'Community messages' });
      await expect(
        afterPersistChannel.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(entriesBeforeAfterPersist.length + 1);
      await expect(
        localPage.getByText('Waiting for community confirmation…', { exact: true })
      ).toHaveCount(0);
      await expect(
        afterPersistChannel.getByText(`@${handle} ${afterPersistMarker}`, { exact: true })
      ).toHaveCount(1);
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
      const heldLocalEntry = await eventually(
        () =>
          json<{ entries: Entry[] }>(
            `${env.local}/api/communities/${refA}/rooms/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.filter((entry) => entry.id === heldEntryId)),
        (entries) => entries.length === 1,
        'the local qualified history did not reconcile the held receipt by its exact remote entry id'
      );
      expect(heldLocalEntry[0]?.id).toBe(heldEntryId);
      await localPage.screenshot({
        path: testInfo.outputPath('native-held-after-persist-receipt.png'),
        fullPage: true,
      });
      await localPage.reload();
      await expect(
        afterPersistChannel.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(entriesBeforeAfterPersist.length + 1);
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
        afterPersistChannel.getByText('Here is what I saw.', { exact: true })
      ).toHaveCount(entriesBeforeAfterPersist.length + 1);
      const releasedRemoteEntry = await pageJson<{ entries: Entry[] }>(
        pageA,
        `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
      );
      expect(releasedRemoteEntry.entries.filter((entry) => entry.id === heldEntryId)).toHaveLength(
        1
      );
      await waitForTurnToSettle(
        recoveredTurnSessionId,
        turnEndCount(afterPersistTurnBeforeStart),
        'the released after-persistence attachment turn did not settle before the live Stop journey'
      );
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refA)}&id=${encodeURIComponent(roomA!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();

      // A real runtime turn waits on its session-scoped step barrier. The Stop
      // button must terminate it before the barrier can release, proving Stop
      // does more than hide a later remote delivery.
      const stoppableScenario = await request.post(`${env.local}/api/test/scenario`, {
        // The room owns one retained (room, agent) session. Set its fixture
        // directly so this barrier does not depend on the global default.
        data: { name: 'stoppable-turn', sessionId: recoveredTurnSessionId },
      });
      const stoppableScenarioAck = (await stoppableScenario.json()) as {
        ok: boolean;
        scenario: string;
      };
      expect(
        stoppableScenario.ok(),
        `could not select the stoppable-turn scenario: ${JSON.stringify(stoppableScenarioAck)}`
      ).toBe(true);
      expect(stoppableScenarioAck).toEqual({ ok: true, scenario: 'stoppable-turn' });
      const stoppableTurnBeforeStart = await sessionSpine(recoveredTurnSessionId);
      expect(stoppableTurnBeforeStart.lifecycle).toBe('idle');
      const readyBeforeStop = await eventually(
        subscriptionBarrier,
        (result) => result !== null && result.snapshotComplete && result.replayComplete,
        'Community A subscription was not ready before the live Stop journey'
      );
      const stopMarker = `stop-marker-${crypto.randomUUID()}`;
      await composer.fill(`@${handle} ${stopMarker}`);
      await pageMemberA.getByRole('button', { name: 'Send' }).click();
      const stopEntry = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageMemberA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.find((entry) => entry.text === `@${handle} ${stopMarker}`)),
        (entry) => entry !== undefined,
        'the live Stop marker did not commit as a Community entry'
      );
      await eventually(
        subscriptionBarrier,
        (result) =>
          result !== null &&
          result.dispatchesSinceBoot === readyBeforeStop!.dispatchesSinceBoot + 1,
        'the live stoppable turn did not receive a dispatcher claim'
      );
      // Room dispatches retain one `(room, agent)` conversation. The recovered
      // binding is therefore the session Stop must target; a session-list delta
      // would mistake retained history for a new turn.
      const stoppableSessionId = recoveredTurnSessionId;
      type DebugDispatch = {
        dispatchId: string;
        origin: string;
        startedAt: string;
        endedAt: string | null;
        outcome: string | null;
        roomId?: string;
        sessionId?: string;
      };
      type DebugRefusal = {
        at: string;
        reason: string;
        visibility: string;
        roomId?: string;
        sessionId?: string;
        entryId?: string;
      };
      type DebugClaim = {
        roomId: string;
        authorId: string;
        entryId: string;
        cascadeRoot: string;
        dispatchId: string;
        claimedAt: string;
        heldMs: number;
        pastDeadline: boolean;
      };
      type DebugHold = {
        roomId: string;
        authorId: string;
        entryId: string;
        behindRoomId: string;
        since: string;
        heldMs: number;
      };
      const captureStopDiagnostics = async () => {
        const [session, subscription, dispatches, refusals] = await Promise.allSettled([
          sessionSpine(stoppableSessionId),
          subscriptionBarrier(),
          json<{ claims: DebugClaim[]; holds: DebugHold[]; recent: DebugDispatch[] }>(
            `${env.local}/api/debug/dispatches?limit=256`
          ),
          json<{ refusals: DebugRefusal[] }>(`${env.local}/api/debug/refusals?limit=256`),
        ]);
        const unavailable = [
          ...(session.status === 'rejected' ? ['session spine'] : []),
          ...(subscription.status === 'rejected' ? ['subscription observation'] : []),
          ...(dispatches.status === 'rejected' ? ['dispatch observation'] : []),
          ...(refusals.status === 'rejected' ? ['refusal observation'] : []),
        ];
        const activeDispatches =
          dispatches.status === 'fulfilled'
            ? dispatches.value.recent.filter(
                (dispatch) => dispatch.sessionId === stoppableSessionId
              )
            : [];
        return {
          scenario: stoppableScenarioAck,
          target: {
            remoteRoomId: roomA!.roomId,
            sessionId: stoppableSessionId,
            remoteEntryId: stopEntry!.id,
          },
          session:
            session.status === 'fulfilled'
              ? {
                  lifecycle: session.value.lifecycle,
                  seq: session.value.seq,
                  projectorLive: session.value.projectorLive,
                  runtime: session.value.runtime,
                  runtimeBound: session.value.runtimeBound,
                  durableEvents: session.value.durableEvents,
                }
              : null,
          subscription:
            subscription.status === 'fulfilled' && subscription.value !== null
              ? {
                  generation: subscription.value.generation,
                  snapshotComplete: subscription.value.snapshotComplete,
                  replayComplete: subscription.value.replayComplete,
                  dispatchesSinceBoot: subscription.value.dispatchesSinceBoot,
                }
              : null,
          dispatches: {
            // These rows use the opaque local mirror room id. It is intentionally
            // reported rather than compared with the qualified remote room id.
            claims:
              dispatches.status === 'fulfilled'
                ? dispatches.value.claims.map((claim) => ({
                    roomId: claim.roomId,
                    authorId: claim.authorId,
                    entryId: claim.entryId,
                    cascadeRoot: claim.cascadeRoot,
                    dispatchId: claim.dispatchId,
                    claimedAt: claim.claimedAt,
                    heldMs: claim.heldMs,
                    pastDeadline: claim.pastDeadline,
                  }))
                : [],
            holds:
              dispatches.status === 'fulfilled'
                ? dispatches.value.holds.map((hold) => ({
                    roomId: hold.roomId,
                    authorId: hold.authorId,
                    entryId: hold.entryId,
                    behindRoomId: hold.behindRoomId,
                    since: hold.since,
                    heldMs: hold.heldMs,
                  }))
                : [],
            recent: activeDispatches.map((dispatch) => ({
              dispatchId: dispatch.dispatchId,
              origin: dispatch.origin,
              startedAt: dispatch.startedAt,
              endedAt: dispatch.endedAt,
              outcome: dispatch.outcome,
              roomId: dispatch.roomId ?? null,
              sessionId: dispatch.sessionId ?? null,
            })),
          },
          refusals:
            refusals.status === 'fulfilled'
              ? refusals.value.refusals.slice(0, 16).map((refusal) => ({
                  at: refusal.at,
                  reason: refusal.reason,
                  visibility: refusal.visibility,
                  roomId: refusal.roomId ?? null,
                  sessionId: refusal.sessionId ?? null,
                  entryId: refusal.entryId ?? null,
                }))
              : [],
          unavailable,
        };
      };
      try {
        await expect
          .poll(
            async () => {
              const session = await sessionSpine(stoppableSessionId);
              // `durableEvents` only contains completed turns. `seq` is the
              // live projector cursor, so it moves before the stopped turn is
              // flushed.
              return (
                session.lifecycle === 'streaming' &&
                (session.seq ?? 0) > (stoppableTurnBeforeStart.seq ?? 0)
              );
            },
            {
              message: 'the live stoppable turn did not enter its bound runtime session',
              // Leave time for an artifact that establishes whether the bridge,
              // dispatcher, or runtime declined this exact Stop marker.
              timeout: 20_000,
            }
          )
          .toBe(true);
      } catch (error) {
        await testInfo.attach('stoppable-turn-diagnostics.json', {
          body: JSON.stringify(await captureStopDiagnostics(), null, 2),
          contentType: 'application/json',
        });
        throw error;
      }
      const stoppableTranscript = await eventually(
        () =>
          json<{ messages: Array<{ content: string }> }>(
            `${env.local}/api/sessions/${stoppableSessionId}/messages?cwd=${encodeURIComponent(agentPath)}`
          ),
        (history) => history.messages.some((message) => message.content.includes('STOPPABLE-TURN')),
        'the live stoppable turn did not stream its pre-Stop marker before Stop'
      );
      expect(
        stoppableTranscript.messages.some((message) => message.content.includes('STOPPABLE-TURN'))
      ).toBe(true);
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
      await waitForTurnToSettle(
        stoppableSessionId,
        turnEndCount(stoppableTurnBeforeStart),
        'the stopped turn did not close its bound runtime session'
      );
      expect((await agentEntries()).some((entry) => entry.text.includes('STOPPABLE-TURN'))).toBe(
        false
      );

      const restoredAttachmentScenario = await request.post(`${env.local}/api/test/scenario`, {
        data: { name: 'rooms-post-attachment', sessionId: recoveredTurnSessionId },
      });
      expect(
        restoredAttachmentScenario.ok(),
        `could not restore attachment scenario after Stop: ${await restoredAttachmentScenario.text()}`
      ).toBe(true);
      const postHumanMarker = async (marker: string) => {
        await composer.fill(marker);
        await pageMemberA.getByRole('button', { name: 'Send' }).click();
        return eventually(
          () =>
            pageJson<{ entries: Entry[] }>(
              pageMemberA,
              `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
            ).then((page) => page.entries.find((entry) => entry.text === marker)),
          (entry) => entry !== undefined,
          `${marker} did not commit as a human Community entry`
        );
      };
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
        const heldParent = await postHumanMarker(`@${handle} ${marker}`);
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
        return { beforeEntryCount: beforeEntries.length, parentEntryId: heldParent!.id };
      };

      const heldStop = await holdAttachmentDelivery(`held-stop-${crypto.randomUUID()}`);
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
      expect(await agentEntries()).toHaveLength(heldStop.beforeEntryCount);
      expect(heldStop.parentEntryId).toBeTruthy();
      await postHumanMarker(`after-held-stop-${crypto.randomUUID()}`);
      expect(await agentEntries()).toHaveLength(heldStop.beforeEntryCount);

      const heldEjection = await holdAttachmentDelivery(`held-ejection-${crypto.randomUUID()}`);
      await localPage.getByRole('button', { name: 'Members', exact: true }).click();
      await expect(
        localPage.getByText(enrollment.agent.displayName, { exact: true })
      ).toBeVisible();
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
      expect(await agentEntries()).toHaveLength(heldEjection.beforeEntryCount);
      expect(heldEjection.parentEntryId).toBeTruthy();
      await postHumanMarker(`after-held-ejection-${crypto.randomUUID()}`);
      expect(await agentEntries()).toHaveLength(heldEjection.beforeEntryCount);
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
      // Ejecting a local agent revokes that agent's membership. The human owner
      // still owns this room and must remain able to read and post through the
      // qualified local Community surface.
      const ownerAfterEjection = `owner-after-ejection-${crypto.randomUUID()}`;
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();
      const localComposer = localPage.getByPlaceholder('Message general…');
      await expect(localComposer).toBeVisible();
      const ownerPostResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/entries`
      );
      await localComposer.fill(ownerAfterEjection);
      await localPage.getByRole('button', { name: 'Send', exact: true }).click();
      const ownerPostResult = await ownerPostResponse;
      expect(
        ownerPostResult.ok(),
        `owner post after agent ejection returned ${ownerPostResult.status()}`
      ).toBe(true);
      await expect(localPage.getByText(ownerAfterEjection, { exact: true })).toBeVisible();
      await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.some((entry) => entry.text === ownerAfterEjection)),
        (posted) => posted,
        'the human owner could not post after the agent was ejected'
      );
      expect(await agentEntries()).toHaveLength(heldEjection.beforeEntryCount);

      // Leave Community A, receive a human post, then navigate back with the
      // local sidebar link. This proves the remote unread cursor and the local
      // accessible navigation path without dispatching another agent turn.
      await localPage.setViewportSize({ width: 1440, height: 900 });
      await localPage.goto(
        `${env.local}/channels?community=${encodeURIComponent(refB)}&id=${encodeURIComponent(roomB!.roomId)}`
      );
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();
      const unreadMarker = `local-unread-${crypto.randomUUID()}`;
      const unreadRoot = await postHumanMarker(unreadMarker);
      expect(unreadRoot?.id).toBeTruthy();
      await eventually(
        () =>
          json<{ cursor: string | null; unreadCount: number }>(
            `${env.local}/api/communities/${refA}/rooms/${roomA!.roomId}/read-cursor`
          ),
        (cursor) => cursor.unreadCount > 0,
        'the remote human post did not advance Community A unread state'
      );
      // The room query is refetched on a fresh local page load; no polling delay
      // is part of this causal barrier.
      await localPage.reload();
      const communityAChannels = localPage.getByRole('region', {
        name: 'Acceptance local install A',
      });
      const communityALink = communityAChannels.getByRole('link', { name: /#general/ });
      await expect(communityALink.getByLabel(/unread messages/)).toBeVisible();
      const markReadResponse = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/read-cursor`
      );
      await communityALink.focus();
      await expect(communityALink).toBeFocused();
      await localPage.keyboard.press('Enter');
      await expect(communityALink).toHaveAttribute('aria-current', 'page');
      await expect(localPage.getByText(unreadMarker, { exact: true })).toBeVisible();
      const markedRead = await markReadResponse;
      expect(markedRead.ok()).toBe(true);
      expect((await markedRead.json()) as { unreadCount: number }).toMatchObject({
        unreadCount: 0,
      });
      await expect(communityALink.getByLabel(/unread messages/)).toHaveCount(0);

      // Reply through the local thread composer and prove the remote parent
      // identity, then use the mobile keyboard path to return to the channel.
      const unreadArticle = localPage.getByRole('article').filter({ hasText: unreadMarker });
      await expect(unreadArticle).toHaveCount(1);
      await unreadArticle.getByRole('button', { name: 'Reply in thread', exact: true }).click();
      const threadFeed = localPage.getByRole('feed', { name: 'Community thread' });
      await expect(threadFeed).toBeVisible();
      const localThreadReply = `local-thread-reply-${crypto.randomUUID()}`;
      const localThreadPost = localPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/communities/${refA}/rooms/${roomA!.roomId}/entries`
      );
      const threadComposer = localPage.getByPlaceholder('Reply in thread…');
      await threadComposer.fill(localThreadReply);
      await threadComposer.press('Enter');
      expect((await localThreadPost).ok()).toBe(true);
      await expect(threadFeed.getByText(localThreadReply, { exact: true })).toBeVisible();
      const remoteThreadReply = await eventually(
        () =>
          pageJson<{ entries: Entry[] }>(
            pageA,
            `/api/v1/channels/${roomA!.roomId}/entries?limit=100`
          ).then((page) => page.entries.find((entry) => entry.text === localThreadReply)),
        (entry) => entry !== undefined && entry.parentEntryId === unreadRoot!.id,
        'the local thread reply did not retain its remote root identity'
      );
      expect(remoteThreadReply?.threadRootEntryId).toBe(unreadRoot!.id);
      await localPage.setViewportSize({ width: 390, height: 844 });
      await expect(threadFeed).toHaveAccessibleName('Community thread');
      await testInfo.attach('native-local-thread-mobile.aria.yml', {
        body: await localPage.getByRole('main').ariaSnapshot({ depth: 6 }),
        contentType: 'text/yaml',
      });
      const backToChannel = localPage.getByRole('button', { name: 'Back to channel', exact: true });
      await expect(backToChannel).toBeVisible();
      await backToChannel.focus();
      await expect(backToChannel).toBeFocused();
      await localPage.keyboard.press('Enter');
      await expect(localPage.getByRole('feed', { name: 'Community messages' })).toBeVisible();
      expect(
        await localPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await localPage.screenshot({
        path: testInfo.outputPath('native-local-thread-mobile.png'),
        fullPage: true,
      });
      expect(await agentEntries()).toHaveLength(heldEjection.beforeEntryCount);
    } finally {
      await Promise.allSettled([
        ownerA.close(),
        ownerB.close(),
        memberA.close(),
        localContext.close(),
      ]);
    }
  });
});
