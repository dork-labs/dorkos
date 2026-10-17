import { expect, type Page } from '@playwright/test';
import { AuthPage } from '../../pages/AuthPage.js';

/** Finish real owner login and first-run choices, then return to the original Doc scope. */
export async function signInOriginalConsumerHost(
  page: Page,
  host: { ownerEmail: string; ownerPassword: string }
): Promise<void> {
  const destination = new URL(page.url());
  destination.searchParams.delete('onboarding');
  const auth = new AuthPage(page);
  await auth.signIn(host.ownerEmail, host.ownerPassword);
  // Clicking submit alone does not mean the original cookie/session request has settled.
  await expect(auth.loginHeading).toBeHidden();
  const [welcome] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === destination.origin &&
        new URL(response.url()).pathname === '/api/onboarding/welcome' &&
        response.request().method() === 'POST'
    ),
    page.getByRole('button', { name: 'Continue without an account', exact: true }).click(),
  ]);
  if (welcome.status() === 503) {
    // This isolated Doc host has no #team/DorkBot greeting; use the real UI's way on.
    expect(await welcome.json()).toMatchObject({ code: 'team_unavailable' });
    await page.getByRole('button', { name: 'Go to #team', exact: true }).click();
  } else {
    expect(welcome.ok()).toBe(true);
  }
  // Landing persists completion asynchronously before it opens Home. Observe that write
  // before restoring the original session/Room URL, so a reload cannot reopen setup.
  await expect
    .poll(async () => {
      const response = await page.request.get(destination.origin + '/api/config');
      expect(response.ok()).toBe(true);
      return (await response.json()).onboarding.completedAt;
    })
    .toEqual(expect.any(String));
  await expect(page).toHaveURL(
    (url) =>
      url.origin === destination.origin &&
      url.pathname === '/' &&
      !url.searchParams.has('onboarding')
  );
  await expect(page.getByTestId('onboarding-landing')).toHaveCount(0);
  await page.goto(destination.href);
  await expect(auth.loginHeading).toBeHidden();
}
