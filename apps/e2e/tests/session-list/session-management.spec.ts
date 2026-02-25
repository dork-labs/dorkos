import { test, expect } from '../../fixtures';

test.describe('Session List — Management @smoke', () => {
  test('creates a new chat session', async ({ basePage, sessionSidebar }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await sessionSidebar.createNewSession();

    // URL should update with new session ID
    await expect(basePage.page).toHaveURL(/session=/);
  });
});
