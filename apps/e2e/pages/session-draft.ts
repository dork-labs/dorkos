import { expect, type Page } from '@playwright/test';

/** Prepare an explicitly new test conversation with a portable private location. */
export async function draftSessionUrl(
  page: Page,
  sessionId: string,
  dir?: string
): Promise<string> {
  let cwd = dir;
  if (!cwd) {
    const response = await page.request.get('/api/directory/default');
    expect(response.ok(), 'could not resolve the draft working directory').toBe(true);
    cwd = ((await response.json()) as { path: string }).path;
  }
  const response = await page.request.post('/api/session-locations', { data: { cwd } });
  expect(response.ok(), 'could not reserve the draft working directory').toBe(true);
  const { id } = (await response.json()) as { id: string };
  return `/session?${new URLSearchParams({ session: sessionId, draft: '1', launchRef: id })}`;
}
