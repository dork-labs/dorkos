import { test, expect } from '../fixtures';
import { MOCK_API_URL, useMockServer } from './chat/mock-server.js';

const agentDir = useMockServer();

test('account model notice lasts through the first reply and a reopened chat', async ({
  page,
  request,
  chatPage,
}, testInfo) => {
  await chatPage.goto(undefined, { dir: agentDir() });
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).not.toBeNull();
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const selected = await request.post(`${MOCK_API_URL}/api/test/scenario`, {
    data: { name: 'account-model-notice', sessionId },
  });
  expect(selected.ok()).toBe(true);
  await chatPage.sendMessage('Show the model replacement');
  const notice = page.getByTestId('model-substituted-row');
  await expect(
    page.getByTestId('transcript-feed').getByText('Reply after model replacement.', { exact: true })
  ).toBeVisible();
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText('Using Available. old-model isn’t available on this account.');
  await page.reload();
  await expect(
    page.getByTestId('transcript-feed').getByText('Reply after model replacement.', { exact: true })
  ).toBeVisible();
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText('Using Available. old-model isn’t available on this account.');
  const history = await request.get(
    `${MOCK_API_URL}/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(agentDir())}`
  );
  expect(history.ok()).toBe(true);
  expect(JSON.stringify(await history.json())).toContain('account-not-available');
  await page.screenshot({
    path: testInfo.outputPath('account-model-notice-reopened.png'),
    fullPage: true,
  });
});
