import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';
import { NewMenuPage } from '../../pages/NewMenuPage';

test.describe('Codex agent creation @smoke', () => {
  test('keeps Codex selected and submits the newborn greeting', async ({
    page,
    request,
    basePage,
  }) => {
    const displayName = `Codex Birth ${randomUUID().slice(0, 8)}`;
    let agentId: string | undefined;

    // This is a browser contract test, so intercept the model-bearing edge after
    // the app has decided which runtime owns the turn. The request itself is the
    // regression proof: before DOR-1927 the create flow dropped `runtime` from
    // the URL, then the newborn kickoff raced agent provenance and never posted.
    await page.route('**/api/sessions/*/messages', async (route) => {
      const incoming = route.request();
      if (incoming.method() !== 'POST') {
        await route.continue();
        return;
      }

      const path = new URL(incoming.url()).pathname.split('/');
      const sessionId = path.at(-2)!;
      const messageId = randomUUID();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId,
          messageId,
          outcome: { messageId, requested: 'queue', applied: 'queue' },
          queuePosition: 1,
        }),
      });
    });

    try {
      await basePage.goto();
      await basePage.waitForAppReady();
      await basePage.ensureSidebarOpen();

      const creationResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/agents/create'
      );
      const kickoffRequest = page.waitForRequest(
        (incoming) =>
          incoming.method() === 'POST' &&
          /\/api\/sessions\/[^/]+\/messages$/.test(new URL(incoming.url()).pathname)
      );

      await new NewMenuPage(page).choose('new-agent');
      await page.getByTestId('gallery-design-your-own').click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(displayName);
      await page.getByTestId('details-toggle').click();
      await page.getByTestId('runtime-codex').click();
      await expect(page.getByTestId('runtime-codex')).toHaveAttribute('aria-checked', 'true');
      await page.getByTestId('create-button').click();

      const created = await creationResponse;
      expect(created.ok()).toBe(true);
      const agent = (await created.json()) as { id: string; _path: string; runtime: string };
      agentId = agent.id;

      await expect(page).toHaveURL(/[?&]runtime=codex(?:&|$)/);
      const landedUrl = new URL(page.url());
      expect(landedUrl.searchParams.get('dir')).toBe(agent._path);
      expect(landedUrl.searchParams.get('runtime')).toBe('codex');

      const kickoff = await kickoffRequest;
      const body = kickoff.postDataJSON() as {
        content: string;
        cwd: string;
        runtime: string;
        agentPath: string;
      };
      expect(body.runtime).toBe('codex');
      expect(body.cwd).toBe(agent._path);
      expect(body.agentPath).toBe(agent._path);
      expect(body.content).toContain('<dork-kickoff>');
    } finally {
      if (agentId) {
        const deleted = await request
          .delete(`/api/mesh/agents/${agentId}/data`)
          .catch(() => undefined);
        if (!deleted?.ok()) {
          await request.delete(`/api/mesh/agents/${agentId}`).catch(() => {});
        }
      }
    }
  });
});
