import { expect, type Page } from '@playwright/test';
import { AuthPage } from '../../pages/AuthPage.js';

/** Finish the real owner login and fresh-install choices before original authenticated controls. */
export async function signInOriginalConsumerHost(
  page: Page,
  host: { ownerEmail: string; ownerPassword: string }
): Promise<void> {
  const auth = new AuthPage(page);
  await auth.signIn(host.ownerEmail, host.ownerPassword);
  // Clicking submit alone does not mean the original cookie/session request has settled.
  await expect(auth.loginHeading).toBeHidden();
  await page.getByRole('button', { name: 'Skip all setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to DorkOS' })).toBeHidden();
  await page.getByRole('button', { name: 'Keep asking me first', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DorkOS runs at full power' })).toBeHidden();
}
