import Database from 'better-sqlite3';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { describeViolation, runAxe } from '../../axe.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';

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
      const agent = access.getByRole('group', { name: seeded.agentName });
      await agent.getByRole('button', { name: 'Read only' }).click();
      await access.getByRole('button', { name: 'Save access' }).click();
      await expect(access.getByTestId('connector-access-outcome')).toBeVisible();

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
): Promise<{ agentId: string; agentName: string }> {
  const response = await request.post(`${apiUrl}/api/test/seed-agent`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { agentId: string };
  return { agentId: body.agentId, agentName: 'E2E Test Agent' };
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
  const response = await request.get(`${apiUrl}/api/connectors/accounts`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { accounts: Array<{ id: string; status: string }> };
  return body.accounts.find((account) => account.id === connectionId)?.status;
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
