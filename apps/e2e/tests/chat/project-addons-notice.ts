import { expect, test } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** What the project add-ons notice tests need from the shared mock leg. */
interface ProjectAddonsNoticeDeps {
  /** The test-mode API base URL. */
  apiUrl: string;
  /** The seeded agent's directory. */
  agentDir: () => string;
}

/**
 * The lasting notice that a project's own OpenCode add-ons are off (DOR-4404):
 * it shows in the chat with DorkOS's own counts, as a muted system row, and is
 * still there after the conversation is reopened.
 *
 * Test-mode's `project-addons-off` scenario sends the same event the OpenCode
 * runtime sends, then an ordinary reply.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerProjectAddonsNoticeTests(deps: ProjectAddonsNoticeDeps): void {
  const { apiUrl, agentDir } = deps;

  test("DOR-4404: says a project's own OpenCode add-ons are off, and keeps saying it", async ({
    page,
    request,
  }) => {
    await request.post(`${apiUrl}/api/test/scenario`, { data: { name: 'project-addons-off' } });
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir() });
    await chatPage.sendMessage('Summarise the readme');

    const notice = page.getByTestId('project-addons-off-row');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText(
      'This project’s own OpenCode add-ons are off: 2 plugins, 1 MCP server.'
    );
    await expect(notice).toContainText('DorkOS doesn’t run a project’s code without your yes.');
    await expect(notice.getByRole('button')).toHaveCount(0);
    // The ordinary reply still arrives after it.
    await expect(
      page.getByTestId('transcript-feed').getByText('Echo: Summarise the readme')
    ).toBeVisible({ timeout: 10_000 });

    // Reopened, the notice is still there, once.
    await page.reload();
    await expect(page.getByTestId('project-addons-off-row')).toHaveCount(1, { timeout: 10_000 });
  });
}
