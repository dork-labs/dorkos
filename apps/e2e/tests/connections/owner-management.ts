import Database from 'better-sqlite3';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { describeViolation, runAxe } from '../../axe.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

interface ReconciliationCandidate {
  operationRevisionId: string;
  operationSlug: string;
  capabilityClassification: 'read' | 'write' | 'destructive';
}

interface ReconciliationPreview {
  previewId: string;
  candidates: ReconciliationCandidate[];
  currentGrants: Array<{ agentId: string; operationRevisionIds: string[] }>;
}

interface ManagementReview {
  reviewRequestId: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
}

interface OwnerManagementHarness {
  apiUrl: string;
  connectWorkAccountViaApi: (request: APIRequestContext) => Promise<string>;
  gotoConnections: (page: Page) => Promise<void>;
}

/** Register P2 owner review tests inside the credential-sequential Connections spec. */
export function registerOwnerManagementTests(harness: OwnerManagementHarness): void {
  test.describe('Connections — exact agent access and owner review', () => {
    test('saves exact named-agent grants and resolves a deep-linked request once', async ({
      page,
      request,
    }) => {
      const connectionId = await harness.connectWorkAccountViaApi(request);
      const seeded = await seedAgent(request, harness.apiUrl);
      const preview = await previewConnection(request, harness.apiUrl, connectionId);
      const read = preview.candidates.find(
        (candidate) => candidate.capabilityClassification === 'read'
      );
      const write = preview.candidates.find(
        (candidate) => candidate.capabilityClassification === 'write'
      );
      expect(read).toBeTruthy();
      expect(write).toBeTruthy();

      await harness.gotoConnections(page);
      const connections = new ConnectionsPage(page);
      const access = await connections.openAccess('Gmail (work)');
      const agent = access.getByRole('group', { name: new RegExp(seeded.agentName) });
      await agent.getByRole('button', { name: 'Read', exact: true }).click();
      await access.getByRole('button', { name: 'Save access' }).click();
      await expect(access.getByTestId('connector-access-outcome')).toHaveText('Access updated');

      const afterAccess = await previewConnection(request, harness.apiUrl, connectionId);
      expect(afterAccess.currentGrants).toContainEqual({
        agentId: seeded.agentId,
        operationRevisionIds: [read!.operationRevisionId],
      });

      const review = await createReview(request, harness.apiUrl, {
        version: 1,
        kind: 'set_agent_access',
        connectionId,
        agentId: seeded.agentId,
        operationRevisionIds: [read!.operationRevisionId, write!.operationRevisionId],
      });
      await page.goto(`/connections?review=${encodeURIComponent(review.reviewRequestId)}`);
      const dialog = page.getByTestId('connector-review-dialog');
      await expect(dialog.getByText('work', { exact: true })).toBeVisible();
      await expect(dialog.getByText('gmail', { exact: true })).toBeVisible();
      await expect(dialog.getByText('List')).toBeVisible();
      await expect(dialog.getByText('Send')).toBeVisible();
      await dialog.getByRole('button', { name: 'Approve access' }).click();
      await expect(dialog.getByTestId('connector-review-outcome')).toHaveAttribute(
        'data-outcome',
        'applied'
      );

      const applied = await getReview(request, harness.apiUrl, review.reviewRequestId);
      expect(applied.state).toBe('approved');
      const replay = await request.post(
        `${harness.apiUrl}/api/connectors/reviews/${review.reviewRequestId}/decision`,
        { data: { decision: 'approved' } }
      );
      expect(replay.status()).toBe(200);
      expect((await replay.json()) as { review: ManagementReview }).toMatchObject({
        review: { reviewRequestId: review.reviewRequestId, state: 'approved' },
      });
      const afterReview = await previewConnection(request, harness.apiUrl, connectionId);
      expect(afterReview.currentGrants).toContainEqual({
        agentId: seeded.agentId,
        operationRevisionIds: [read!.operationRevisionId, write!.operationRevisionId].sort(),
      });
      await page.keyboard.press('Escape');
      // The same canonical revision grants are visible from the named agent's
      // profile, and its Manage action returns to the owner workspace.
      const rightPanel = new RightPanelPage(page);
      await rightPanel.openProfilePage('connections', seeded.agentDir);
      const profileAccount = page.getByTestId(`agent-connection-${connectionId}`);
      await expect(profileAccount).toContainText('Gmail (work)');
      await expect(profileAccount).toContainText('2 approved actions');
      await expect(profileAccount).toContainText('Available');
      const profileAccess = await request.get(
        `${harness.apiUrl}/api/connectors/agents/${seeded.agentId}/connections`
      );
      expect(profileAccess.ok()).toBe(true);
      expect(await profileAccess.json()).toMatchObject({
        connections: [
          expect.objectContaining({
            connectionId,
            operationRevisionIds: [read!.operationRevisionId, write!.operationRevisionId].sort(),
          }),
        ],
      });
      await page
        .locator('[aria-labelledby="agent-account-access"]')
        .getByRole('button', { name: 'Manage', exact: true })
        .click();
      await expect(page).toHaveURL(/\/connections/);
      const removal = await connections.openAccess('Gmail (work)');
      const removedAgent = removal.getByRole('group', { name: new RegExp(seeded.agentName) });
      await removedAgent.getByRole('button', { name: 'No access', exact: true }).click();
      await removal.getByRole('button', { name: 'Save access' }).click();
      await expect(removal.getByTestId('connector-access-outcome')).toHaveText('Access updated');
      const afterRemoval = await previewConnection(request, harness.apiUrl, connectionId);
      expect(
        afterRemoval.currentGrants.filter((grant) => grant.agentId === seeded.agentId)
      ).toEqual([]);
      await rightPanel.openProfilePage('connections', seeded.agentDir);
      await expect(page.getByText('No account access', { exact: true })).toBeVisible();
      await expect(page.getByTestId(`agent-connection-${connectionId}`)).toHaveCount(0);
    });

    test('resumes approved sign-in through the durable flow route after reload', async ({
      page,
      request,
    }) => {
      const existingId = await harness.connectWorkAccountViaApi(request);
      const detail = await request.get(
        `${harness.apiUrl}/api/connectors/connections/${existingId}`
      );
      expect(detail.ok()).toBe(true);
      const { connection } = (await detail.json()) as {
        connection: { providerInstanceId: string };
      };
      const review = await createReview(request, harness.apiUrl, {
        version: 1,
        kind: 'connect',
        providerInstanceId: connection.providerInstanceId,
        toolkit: 'gmail',
        label: 'review account',
      });
      await page.goto(`/connections?review=${encodeURIComponent(review.reviewRequestId)}`);
      let dialog = page.getByTestId('connector-review-dialog');
      await dialog.getByRole('button', { name: 'Approve and continue' }).click();
      await expect(dialog.getByText('Sign-in still required', { exact: true })).toBeVisible();
      const before = await request.get(
        `${harness.apiUrl}/api/connectors/reviews/${review.reviewRequestId}`
      );
      expect(before.ok()).toBe(true);
      const approved = (await before.json()) as {
        resolution: { authentication: { flowId: string } };
      };
      const flowId = approved.resolution.authentication.flowId;
      expect(flowId).toBeTruthy();
      await page.reload();
      dialog = page.getByTestId('connector-review-dialog');
      await expect(dialog.getByRole('link', { name: 'Continue to sign in' })).toBeVisible();
      const durablePoll = page.waitForResponse((response) =>
        response.url().endsWith(`/api/connectors/authentication-flows/${flowId}`)
      );
      const popup = page.waitForEvent('popup');
      await dialog.getByRole('link', { name: 'Continue to sign in' }).click();
      const signIn = await popup;
      const polled = await durablePoll;
      expect(polled.ok()).toBe(true);
      const connected = (await polled.json()) as {
        state: string;
        flowId: string;
        connectionId: string;
      };
      expect(connected).toMatchObject({ state: 'connected', flowId });
      expect(connected.connectionId).not.toBe(existingId);
      await expect(dialog.getByText('Account connected', { exact: true })).toBeVisible();
      await signIn.close();
      await page.reload();
      dialog = page.getByTestId('connector-review-dialog');
      await expect(dialog.getByText('Account connected', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Sign-in still required', { exact: true })).toHaveCount(0);
      const replay = await request.post(
        `${harness.apiUrl}/api/connectors/reviews/${review.reviewRequestId}/decision`,
        { data: { decision: 'approved' } }
      );
      expect(replay.ok()).toBe(true);
      expect(await replay.json()).toMatchObject({
        review: { resolution: { authentication: { flowId } } },
      });
      const inventory = await request.get(`${harness.apiUrl}/api/connectors/connections`);
      expect(inventory.ok()).toBe(true);
      const { connections: accounts } = (await inventory.json()) as {
        connections: Array<{ connectionId: string; label: string }>;
      };
      expect(accounts.filter((account) => account.label === 'review account')).toEqual([
        expect.objectContaining({ connectionId: connected.connectionId }),
      ]);
      const preview = await previewConnection(request, harness.apiUrl, connected.connectionId);
      expect(preview.currentGrants).toEqual([]);
    });

    test('reconnects a disconnected account and removes it only after an acknowledged request', async ({
      page,
      request,
    }) => {
      const initialId = await harness.connectWorkAccountViaApi(request);
      await harness.gotoConnections(page);
      const detail = page.getByTestId('connection-detail');
      const row = (id: string) => page.getByTestId(`connection-row-${id}`);
      const disconnect = async (id: string) => {
        await row(id).getByRole('button').click();
        await detail.getByRole('button', { name: 'Disconnect', exact: true }).click();
        const confirmation = page.getByRole('alertdialog', { name: 'Disconnect this account?' });
        await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await expect(detail).toBeHidden();
        await expect(
          page
            .getByRole('region', { name: 'Disconnected accounts', exact: true })
            .getByTestId(`connection-row-${id}`)
        ).toBeVisible();
        const result = await request.get(`${harness.apiUrl}/api/connectors/connections/${id}`);
        expect(result.ok()).toBe(true);
        expect(await result.json()).toMatchObject({
          connection: { lifecycle: 'disconnected', externalCleanup: 'complete' },
        });
      };

      await expect(
        page
          .getByRole('region', { name: 'Connected accounts', exact: true })
          .getByTestId(`connection-row-${initialId}`)
      ).toBeVisible();
      await disconnect(initialId);
      await page.screenshot({
        path: test.info().outputPath('disconnected-accounts-desktop.png'),
        fullPage: true,
      });
      await row(initialId).getByRole('button').click();
      const initiated = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/connections/${initialId}/reconnect`)
      );
      await detail.getByRole('button', { name: 'Reconnect', exact: true }).click();
      const initiation = await initiated;
      expect(initiation.ok()).toBe(true);
      const { flowId } = (await initiation.json()) as { flowId: string };
      expect(flowId).toBeTruthy();
      const auth = page.getByTestId('connect-auth-dialog');
      await expect(auth.getByText('Gmail is connected', { exact: true })).toBeVisible();
      const state = await request.get(
        `${harness.apiUrl}/api/connectors/authentication-flows/${flowId}`
      );
      expect(state.ok()).toBe(true);
      const completed = (await state.json()) as { state: string; connectionId: string };
      expect(completed.state).toBe('connected');
      expect(completed.connectionId).toBeTruthy();
      await auth.getByRole('button', { name: 'Choose agents' }).click();
      const access = page.getByRole('dialog', { name: 'Choose agent access' });
      await expect(access).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(access).toBeHidden();
      await expect(
        page
          .getByRole('region', { name: 'Connected accounts', exact: true })
          .getByTestId(`connection-row-${completed.connectionId}`)
      ).toBeVisible();
      await disconnect(completed.connectionId);

      const removePath = `**/api/connectors/connections/${completed.connectionId}/remove`;
      await page.route(
        removePath,
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic removal failure' }),
          }),
        { times: 1 }
      );
      await row(completed.connectionId).getByRole('button').click();
      await detail.getByTestId('remove-account').click();
      let confirmation = page.getByRole('alertdialog', {
        name: 'Remove this account from Accounts?',
      });
      const failed = page.waitForResponse((response) =>
        response.url().endsWith(`/connections/${completed.connectionId}/remove`)
      );
      await confirmation.getByRole('button', { name: 'Remove from Accounts', exact: true }).click();
      expect((await failed).status()).toBe(503);
      await expect(detail.getByRole('alert')).toContainText(
        'Check the account’s current status before trying again.'
      );
      await page.reload();
      await expect(
        page
          .getByRole('region', { name: 'Disconnected accounts', exact: true })
          .getByTestId(`connection-row-${completed.connectionId}`)
      ).toBeVisible();
      await row(completed.connectionId).getByRole('button').click();
      await detail.getByTestId('remove-account').click();
      confirmation = page.getByRole('alertdialog', { name: 'Remove this account from Accounts?' });
      await expect(confirmation).toContainText('past usage and activity will remain');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        confirmation.getByRole('button', { name: 'Remove from Accounts', exact: true })
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath('remove-account-mobile.png'),
        fullPage: true,
      });
      const removed = page.waitForResponse((response) =>
        response.url().endsWith(`/connections/${completed.connectionId}/remove`)
      );
      await confirmation.getByRole('button', { name: 'Remove from Accounts', exact: true }).click();
      expect((await removed).status()).toBe(204);
      await expect(detail).toBeHidden();
      await expect(row(completed.connectionId)).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Connected accounts', exact: true })
      ).toBeVisible();
      await expect(row(completed.connectionId)).toHaveCount(0);
      const inventory = await request.get(`${harness.apiUrl}/api/connectors/connections`);
      expect(inventory.ok()).toBe(true);
      const body = (await inventory.json()) as { connections: Array<{ connectionId: string }> };
      expect(body.connections.map((account) => account.connectionId)).not.toContain(
        completed.connectionId
      );
    });

    test('renames, pauses, resumes and disconnects the exact account with visible usage', async ({
      page,
      request,
      playwright,
    }) => {
      const connectionId = await harness.connectWorkAccountViaApi(request);
      const seeded = await seedAgent(request, harness.apiUrl);
      const preview = await previewConnection(request, harness.apiUrl, connectionId);
      const read = preview.candidates.find(
        (candidate) => candidate.capabilityClassification === 'read'
      )!;
      const grant = await request.post(`${harness.apiUrl}/api/connectors/reconciliation/apply`, {
        data: {
          previewId: preview.previewId,
          grants: [{ agentId: seeded.agentId, operationRevisionIds: [read.operationRevisionId] }],
        },
      });
      expect(grant.ok()).toBe(true);
      const key = await createProgramKey(request, harness.apiUrl);
      const programRequest = await playwright.request.newContext();
      const execute = () =>
        programRequest.post(`${harness.apiUrl}/api/connectors/executions`, {
          headers: { authorization: `Bearer ${key.key}` },
          data: {
            agentId: seeded.agentId,
            connectionId,
            operationRevisionId: read.operationRevisionId,
            arguments: { query: 'harmless-browser-read' },
          },
        });
      try {
        const first = await execute();
        expect(first.status(), await first.text()).toBe(200);
        expect(await first.json()).toMatchObject({
          result: { status: 'success' },
          attemptCount: 1,
        });
        await harness.gotoConnections(page);
        const connections = new ConnectionsPage(page);
        await connections.account('Gmail (work)').getByRole('button').click();
        const detail = page.getByTestId('connection-detail');
        await detail.getByLabel('Label', { exact: true }).fill('renamed');
        await detail.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(detail.getByRole('heading', { name: 'Gmail (renamed)' })).toBeVisible();
        await expect(
          detail.getByText('1 logical operations, 1 attempts.', { exact: true })
        ).toBeVisible();
        await detail.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(detail.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
        await expect
          .poll(async () => {
            const response = await request.get(
              `${harness.apiUrl}/api/connectors/connections/${connectionId}`
            );
            expect(response.ok()).toBe(true);
            return ((await response.json()) as { connection: { lifecycle: string } }).connection
              .lifecycle;
          })
          .toBe('paused');
        const paused = await execute();
        expect(paused.status()).toBe(409);
        expect(await paused.json()).toMatchObject({ code: 'CONNECTOR_NOT_EXECUTABLE' });
        await detail.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(detail.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
        const resumed = await execute();
        expect(resumed.status(), await resumed.text()).toBe(200);
        await harness.gotoConnections(page);
        await connections.account('Gmail (renamed)').getByRole('button').click();
        await expect(
          detail.getByText('2 logical operations, 2 attempts.', { exact: true })
        ).toBeVisible();
        await detail.getByRole('button', { name: 'Disconnect', exact: true }).click();
        const impact = page.getByRole('alertdialog', { name: 'Disconnect this account?' });
        await expect(
          impact.getByText(
            '1 agents, 0 sessions, and 0 subscriptions will lose access. 0 pending deliveries will stop.',
            { exact: true }
          )
        ).toBeVisible();
        await impact.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await expect(detail).toBeHidden();
        const after = await request.get(
          `${harness.apiUrl}/api/connectors/connections/${connectionId}`
        );
        expect(after.ok()).toBe(true);
        expect(await after.json()).toMatchObject({
          connection: { connectionId, label: 'renamed', lifecycle: 'disconnected' },
        });
        const usage = await request.get(
          `${harness.apiUrl}/api/connectors/usage/operator?connectionId=${encodeURIComponent(connectionId)}`
        );
        expect(usage.ok()).toBe(true);
        const usageBody = await usage.json();
        expect(usageBody.items).toHaveLength(2);
        expect(JSON.stringify(usageBody)).not.toContain('harmless-browser-read');
        expect((await execute()).status()).not.toBe(200);
      } finally {
        await programRequest.dispose();
        const deleted = await request.post(`${harness.apiUrl}/api/auth/api-key/delete`, {
          headers: { origin: harness.apiUrl },
          data: { keyId: key.id },
        });
        expect(deleted.ok()).toBe(true);
      }
    });

    test('denial and expiry cannot change the account', async ({ page, request }) => {
      const connectionId = await harness.connectWorkAccountViaApi(request);
      const denied = await createReview(request, harness.apiUrl, {
        version: 1,
        kind: 'pause',
        connectionId,
      });
      await page.goto(`/connections?review=${encodeURIComponent(denied.reviewRequestId)}`);
      const denyDialog = page.getByTestId('connector-review-dialog');
      await denyDialog.getByRole('button', { name: 'Deny' }).click();
      await expect(denyDialog.getByTestId('connector-review-outcome')).toHaveAttribute(
        'data-outcome',
        'denied'
      );
      expect(await accountStatus(request, harness.apiUrl, connectionId)).toBe('active');

      const expired = await createReview(request, harness.apiUrl, {
        version: 1,
        kind: 'pause',
        connectionId,
      });
      expireReview(expired.reviewRequestId);
      await page.goto(`/connections?review=${encodeURIComponent(expired.reviewRequestId)}`);
      const expiredDialog = page.getByTestId('connector-review-dialog');
      await expect(expiredDialog.getByTestId('connector-review-outcome')).toHaveAttribute(
        'data-outcome',
        'expired'
      );
      await expect(expiredDialog.getByRole('button', { name: /approve/i })).toHaveCount(0);
      const lateDecision = await request.post(
        `${harness.apiUrl}/api/connectors/reviews/${expired.reviewRequestId}/decision`,
        { data: { decision: 'approved' } }
      );
      expect(lateDecision.status()).toBe(200);
      expect((await lateDecision.json()) as { review: ManagementReview }).toMatchObject({
        review: { reviewRequestId: expired.reviewRequestId, state: 'expired' },
      });
      expect(await accountStatus(request, harness.apiUrl, connectionId)).toBe('active');
    });

    test('keeps review detail usable across themes, phone layout, keyboard, and history', async ({
      page,
      request,
    }, testInfo) => {
      const connectionId = await harness.connectWorkAccountViaApi(request);
      const seeded = await seedAgent(request, harness.apiUrl);
      const preview = await previewConnection(request, harness.apiUrl, connectionId);
      const read = preview.candidates.find(
        (candidate) => candidate.capabilityClassification === 'read'
      );
      expect(read).toBeTruthy();
      const apply = await request.post(`${harness.apiUrl}/api/connectors/reconciliation/apply`, {
        data: {
          previewId: preview.previewId,
          grants: [{ agentId: seeded.agentId, operationRevisionIds: [read!.operationRevisionId] }],
        },
      });
      expect(apply.ok()).toBe(true);
      const review = await createReview(request, harness.apiUrl, {
        version: 1,
        kind: 'disconnect',
        connectionId,
      });
      await harness.gotoConnections(page);
      const row = page.getByTestId(`connector-review-row-${review.reviewRequestId}`);
      await row.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`review=${review.reviewRequestId}`));
      await expect(page.getByTestId('connector-review-dialog')).toBeVisible();
      await expect(page.getByTestId('connector-review-impact')).toBeVisible();
      await expect(page.getByTestId('connector-review-custody')).toBeVisible();
      await settleFiniteAnimations(page.getByTestId('connector-review-dialog'));
      const accessibility = await runAxe(page, '[role="dialog"]');
      expect(
        accessibility.violations.map(describeViolation),
        'the exact owner review dialog should have no automated accessibility violations'
      ).toEqual([]);
      await testInfo.attach('owner-review-desktop-light.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      await page.emulateMedia({ colorScheme: 'dark' });
      await settleFiniteAnimations(page.getByTestId('connector-review-dialog'));
      const darkAccessibility = await runAxe(page, '[role="dialog"]');
      expect(
        darkAccessibility.violations.map(describeViolation),
        'the exact owner review dialog should remain accessible in dark mode'
      ).toEqual([]);
      await testInfo.attach('owner-review-desktop-dark.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      const desktopDialog = page.getByTestId('connector-review-dialog');
      const desktopApprove = desktopDialog.getByRole('button', { name: 'Approve disconnect' });
      await desktopApprove.focus();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(desktopDialog).toBeVisible();
      await expect(desktopApprove).toBeVisible();
      await expect(desktopApprove).toBeFocused();
      await expect(desktopDialog).not.toHaveAttribute('data-vaul-drawer');
      await desktopApprove.scrollIntoViewIfNeeded();
      const resizedActionBounds = await desktopApprove.boundingBox();
      expect(resizedActionBounds).not.toBeNull();
      expect(resizedActionBounds!.y).toBeGreaterThanOrEqual(0);
      expect(resizedActionBounds!.y + resizedActionBounds!.height).toBeLessThanOrEqual(844);

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
      await page.goBack();
      const phoneDialog = page.getByTestId('connector-review-dialog');
      await expect(phoneDialog).toBeVisible();
      await expect(phoneDialog).toHaveAttribute('data-vaul-drawer');
      expect(await phoneDialog.evaluate((element) => getComputedStyle(element).position)).toBe(
        'fixed'
      );
      await expectDrawerContained(phoneDialog, 844);
      await expect(phoneDialog.getByRole('button', { name: 'Approve disconnect' })).toBeVisible();
      await page.emulateMedia({ colorScheme: 'light' });
      await settleFiniteAnimations(phoneDialog);
      await testInfo.attach('owner-review-phone-light.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.emulateMedia({ colorScheme: 'dark' });
      await settleFiniteAnimations(phoneDialog);
      await testInfo.attach('owner-review-phone-dark.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.goBack();
      const reopenedPhoneDialog = page.getByTestId('connector-review-dialog');
      await expect(reopenedPhoneDialog).toBeVisible();
      await expect(reopenedPhoneDialog).toHaveAttribute('data-vaul-drawer');

      // A direct URL load is the controlled initially-open path used by review links.
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await page.reload();
      const reducedMotionDialog = page.getByTestId('connector-review-dialog');
      await expect(reducedMotionDialog).toBeVisible();
      await expect(reducedMotionDialog).toHaveAttribute('data-vaul-drawer');
      await expectDrawerContained(reducedMotionDialog, 844);
      await expect(
        reducedMotionDialog.getByRole('button', { name: 'Approve disconnect' })
      ).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
      ).toBe(true);
      await page.keyboard.press('Tab');
      await expect(reducedMotionDialog.locator(':focus')).toHaveCount(1);

      // Remount under normal motion so the gesture follows the same lifecycle as
      // a drawer opened with the user's usual motion preference. Changing the
      // media query alone leaves the already-mounted reduced-motion primitive
      // without an entrance animation while Vaul still guards early gestures.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.reload();
      const draggableDialog = page.getByTestId('connector-review-dialog');
      await expect(draggableDialog).toBeVisible();
      await expect(draggableDialog).toHaveAttribute('data-vaul-drawer');
      await settleFiniteAnimations(draggableDialog);
      const dragBounds = await draggableDialog.boundingBox();
      expect(dragBounds).not.toBeNull();
      const dragX = dragBounds!.x + dragBounds!.width / 2;
      const dragY = dragBounds!.y + 20;
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragX, 820, { steps: 12 });
      await page.mouse.up();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.goBack();
      await expect(page.getByTestId('connector-review-dialog')).toBeVisible();
      await page.goForward();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });
}

async function settleFiniteAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const finite = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.allSettled(finite.map((animation) => animation.finished));
  });
}

async function expectDrawerContained(dialog: Locator, viewportHeight: number): Promise<void> {
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds ? Math.ceil(bounds.y + bounds.height) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(viewportHeight);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight);
}

async function seedAgent(
  request: APIRequestContext,
  apiUrl: string
): Promise<{ agentId: string; agentName: string; agentDir: string }> {
  const response = await request.post(`${apiUrl}/api/test/seed-agent`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { agentId: string; agentDir: string };
  return { agentId: body.agentId, agentDir: body.agentDir, agentName: 'E2E Test Agent' };
}

async function previewConnection(
  request: APIRequestContext,
  apiUrl: string,
  connectionId: string
): Promise<ReconciliationPreview> {
  const response = await request.post(`${apiUrl}/api/connectors/reconciliation/previews`, {
    data: { connectionId },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as ReconciliationPreview;
}

async function createReview(
  request: APIRequestContext,
  apiUrl: string,
  action: Record<string, unknown>
): Promise<ManagementReview> {
  const response = await request.post(`${apiUrl}/api/connectors/reviews`, {
    data: { action, idempotencyKey: `e2e-${crypto.randomUUID()}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as ManagementReview;
}

async function getReview(
  request: APIRequestContext,
  apiUrl: string,
  reviewRequestId: string
): Promise<ManagementReview> {
  const response = await request.get(`${apiUrl}/api/connectors/reviews/${reviewRequestId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ManagementReview;
}

async function accountStatus(
  request: APIRequestContext,
  apiUrl: string,
  connectionId: string
): Promise<string | undefined> {
  const response = await request.get(`${apiUrl}/api/connectors/connections`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    connections: Array<{ connectionId: string; authenticationStatus: string }>;
  };
  return body.connections.find((connection) => connection.connectionId === connectionId)
    ?.authenticationStatus;
}

function expireReview(reviewRequestId: string): void {
  // The browser still drives the real route. This test-only clock lever changes
  // only the durable expiry timestamp in the throwaway, port-keyed DORK_HOME.
  // eslint-disable-next-line no-restricted-syntax -- Playwright config uses the same test env seam.
  const port = process.env.DORKOS_MOCK_PORT || '4243';
  const db = new Database(`/tmp/dorkos-test-mode-${port}/dork.db`);
  try {
    db.prepare('UPDATE connector_review_requests SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      reviewRequestId
    );
  } finally {
    db.close();
  }
}

/** Issue an ephemeral program key through real local owner authentication. */
async function createProgramKey(
  request: APIRequestContext,
  apiUrl: string
): Promise<{ id: string; key: string }> {
  const account = {
    email: 'connections-owner@e2e.dorkos.local',
    password: 'connections-owner-test-password',
  };
  let signedIn = await request.post(`${apiUrl}/api/auth/sign-in/email`, {
    headers: { origin: apiUrl },
    data: account,
  });
  if (!signedIn.ok()) {
    const signup = await request.post(`${apiUrl}/api/auth/sign-up/email`, {
      headers: { origin: apiUrl },
      data: { ...account, name: 'Connections test owner' },
    });
    expect(signup.ok()).toBe(true);
    signedIn = await request.post(`${apiUrl}/api/auth/sign-in/email`, {
      headers: { origin: apiUrl },
      data: account,
    });
  }
  expect(signedIn.ok()).toBe(true);
  const created = await request.post(`${apiUrl}/api/auth/api-key/create`, {
    headers: { origin: apiUrl },
    data: { name: 'Connections browser protocol', expiresIn: 86400 },
  });
  expect(created.ok()).toBe(true);
  return (await created.json()) as { id: string; key: string };
}
