import { expect, type Locator, type Page, type Response } from '@playwright/test';

/** Join the original UI action and every matching save, including on failure. */
async function chooseMoment(
  page: Page,
  button: Locator,
  matches: Array<(response: Response) => boolean>
): Promise<Response[]> {
  const responses: Response[] = [];
  const failure: { first?: { value: unknown } } = {};
  const saving = matches.map((match, index) =>
    page.waitForResponse(match, { timeout: 10_000 }).then(
      (response) => {
        responses[index] = response;
      },
      (value) => {
        failure.first ??= { value };
      }
    )
  );
  const clicking = button.click({ timeout: 10_000 }).catch((value) => {
    failure.first ??= { value };
  });
  await Promise.allSettled([...saving, clicking]);
  if (failure.first) throw failure.first.value;
  for (const response of responses) expect(response.status()).toBe(200);
  return responses;
}

/** Read only the original UI request's JSON fields used to correlate its save. */
function choiceBody(response: Response, method: string, path: string) {
  if (response.request().method() !== method || new URL(response.url()).pathname !== path) return;
  try {
    const body: unknown = JSON.parse(response.request().postData() ?? 'null');
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    /* Unrelated or malformed responses cannot match this UI choice. */
  }
}

/** Answer only rendered first-run setup and consent, retaining every original save and readback. */
export async function prepareOriginalManagedOnboarding(page: Page): Promise<void> {
  const shell = page.getByRole('button', { name: 'Open command palette', exact: true });
  const skipSetup = page.getByRole('button', { name: 'Skip all setup', exact: true });
  // Fresh installs show real first-run setup instead of the app header.
  await expect(
    shell
      .or(skipSetup)
      .or(page.getByRole('dialog', { name: 'DorkOS runs at full power', exact: true }))
      .or(page.getByRole('dialog', { name: 'Share anonymous usage data?', exact: true }))
      .first()
  ).toBeVisible({ timeout: 10_000 });
  if (await skipSetup.isVisible()) {
    const dismissedAt = (response: Response): string | undefined => {
      const request = response.request();
      if (request.method() !== 'PATCH' || new URL(response.url()).pathname !== '/api/config')
        return;
      try {
        const patch: unknown = JSON.parse(request.postData() ?? 'null');
        if (!patch || typeof patch !== 'object') return;
        const onboarding = (patch as Record<string, unknown>).onboarding;
        if (!onboarding || typeof onboarding !== 'object') return;
        const value = (onboarding as Record<string, unknown>).dismissedAt;
        return typeof value === 'string' ? value : undefined;
      } catch {
        return;
      }
    };
    const dismissal: { response?: Response; first?: { value: unknown } } = {};
    const saving = page
      .waitForResponse((response) => dismissedAt(response) !== undefined, { timeout: 10_000 })
      .then(
        (response) => {
          dismissal.response = response;
        },
        (value) => {
          dismissal.first ??= { value };
        }
      );
    const clicking = skipSetup.click({ timeout: 10_000 }).catch((value) => {
      dismissal.first ??= { value };
    });
    await Promise.allSettled([saving, clicking]);
    if (dismissal.first) throw dismissal.first.value;
    const originalResponse = dismissal.response;
    if (!originalResponse) throw new Error('Original setup dismissal response required');
    expect(originalResponse.status()).toBe(200);
    const persisted = await page.request.get('/api/config');
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({
      onboarding: { dismissedAt: dismissedAt(originalResponse) },
    });
  }
  // The disposable install answers normal consent doors through their real UI.
  // Closing X would leave the question eligible again on every later full page load.
  const configBefore = await page.request.get('/api/config');
  expect(configBefore.status()).toBe(200);
  const beforeChoices = await configBefore.json();
  if (beforeChoices.ui.fullPowerDecidedAt == null) {
    const door = page.getByRole('dialog', { name: 'DorkOS runs at full power', exact: true });
    await expect(door).toBeVisible({ timeout: 10_000 });
    const [decision] = await chooseMoment(
      page,
      door.getByRole('button', { name: 'Keep asking me first', exact: true }),
      [
        (response) => {
          const ui = choiceBody(response, 'PATCH', '/api/config')?.ui;
          return (
            !!ui &&
            typeof ui === 'object' &&
            (ui as Record<string, unknown>).fullPowerChoice === 'supervised' &&
            typeof (ui as Record<string, unknown>).fullPowerDecidedAt === 'string'
          );
        },
        (response) => {
          const body = choiceBody(response, 'PUT', '/api/permissions/preset');
          return body?.preset === 'careful' && body.surface === 'first-run';
        },
      ]
    );
    const saved = await page.request.get('/api/config');
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({
      ui: choiceBody(decision!, 'PATCH', '/api/config')?.ui,
    });
    const permissions = await page.request.get('/api/permissions');
    expect(permissions.status()).toBe(200);
    expect(await permissions.json()).toMatchObject({ preset: 'careful' });
    await expect(door).toBeHidden({ timeout: 10_000 });
  }
  const telemetryBefore = await page.request.get('/api/config');
  expect(telemetryBefore.status()).toBe(200);
  if (!(await telemetryBefore.json()).telemetry.userHasDecided) {
    // MomentHost shows at most one question per launch; a normal reload asks the next.
    await page.reload();
    const telemetry = page.getByRole('dialog', {
      name: 'Share anonymous usage data?',
      exact: true,
    });
    await expect(telemetry).toBeVisible({ timeout: 10_000 });
    await chooseMoment(page, telemetry.getByRole('button', { name: 'Don’t share', exact: true }), [
      (response) => {
        const value = choiceBody(response, 'PATCH', '/api/config')?.telemetry;
        if (!value || typeof value !== 'object') return false;
        const fields = value as Record<string, unknown>;
        return (
          fields.install === false &&
          fields.heartbeat === false &&
          fields.usage === false &&
          fields.userHasDecided === true
        );
      },
    ]);
    const saved = await page.request.get('/api/config');
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({
      telemetry: { install: false, heartbeat: false, usage: false, userHasDecided: true },
    });
    await expect(telemetry).toBeHidden({ timeout: 10_000 });
  }
  await expect(shell).toBeVisible({ timeout: 10_000 });
}
