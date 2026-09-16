/** Helpers for the sealed Community and local DorkOS packaged proof. */
import { expect, type Page } from '@playwright/test';

/** URLs and fixture-only setup secrets supplied by the sealed deployment runner. */
export type AcceptanceEnvironment = {
  communityA: string;
  communityB: string;
  local: string;
  control: string;
  root: string;
  communityASecret: string;
  communityBSecret: string;
};

/** Read the complete required packaged-proof contract without defaulting or skipping. */
export function acceptanceEnvironment(): AcceptanceEnvironment {
  const requireValue = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for packaged Community acceptance.`);
    return value;
  };
  return {
    communityA: requireValue('COMMUNITY_ACCEPTANCE_A_URL'),
    communityB: requireValue('COMMUNITY_ACCEPTANCE_B_URL'),
    local: requireValue('COMMUNITY_ACCEPTANCE_LOCAL_URL'),
    control: requireValue('COMMUNITY_ACCEPTANCE_CONTROL_URL'),
    root: requireValue('COMMUNITY_ACCEPTANCE_ROOT'),
    communityASecret: requireValue('COMMUNITY_ACCEPTANCE_A_SECRET'),
    communityBSecret: requireValue('COMMUNITY_ACCEPTANCE_B_SECRET'),
  };
}

/** Require a successful JSON response, preserving only status and public body on failure. */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${init?.method ?? 'GET'} ${new URL(url).pathname} returned ${response.status}: ${body}`
    );
  }
  return (await response.json()) as T;
}

/** Bootstrap one independent human through the built Community browser, not a private setup API. */
export async function bootstrapCommunity(
  page: Page,
  input: { url: string; secret: string; name: string; email: string; community: string }
): Promise<void> {
  await page.goto(input.url);
  await page.getByLabel('Setup secret').fill(input.secret);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Your name').fill(input.name);
  await page.getByLabel('Email').fill(input.email);
  await page.getByLabel('Password').fill('acceptance-password');
  await page.getByLabel('Community name').fill(input.community);
  await page.getByLabel('First channel').fill('general');
  await page.getByRole('button', { name: 'Create community' }).click();
  await expect(page.getByText('#general')).toBeVisible();
}

/** Wait on a bounded observable condition rather than sleeping between remote retries. */
export async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string
): Promise<T> {
  let observed: T | undefined;
  await expect
    .poll(
      async () => {
        observed = await read();
        return predicate(observed);
      },
      { message: label, timeout: 90_000 }
    )
    .toBe(true);
  return observed as T;
}

/** Get browser-authenticated JSON so Community cookies remain private to that browser context. */
export async function pageJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath);
    if (!response.ok) throw new Error(`${requestPath} returned ${response.status}`);
    return response.json();
  }, path) as Promise<T>;
}
