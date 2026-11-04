import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../../fixtures';

/** A real local package, reviewed through the real service; no command is executed. */
test('whole hook review and one-at-a-time recovery @permissions', async ({ request, basePage }) => {
  const config = await (await request.get('/api/config')).json();
  const project = await mkdtemp(join(config.dorkHome, 'cedar-review-'));
  const plugin = join(project, '.dork/plugins/lunar-hooks');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'hooks'), { recursive: true });
  await writeFile(
    join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'lunar-hooks', version: '1.0.0' })
  );
  await writeFile(join(plugin, 'hooks/guard.mjs'), 'export const guard = true;\n');
  const command = `node "${plugin}/hooks/guard.mjs"`;
  async function setHooks(padding: string) {
    await writeFile(
      join(plugin, 'hooks/hooks.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash|Write',
              hooks: [{ type: 'command', command: `${command}${padding}--label "40 spaces"` }],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command }] }],
        },
      })
    );
  }
  const agent = await (
    await request.post('/api/test/seed-agent', { data: { slot: 'permission-requester' } })
  ).json();
  async function seed() {
    const response = await request.post('/api/test/seed-approval', {
      data: {
        capabilityId: 'harness.project_hooks',
        agentPath: agent.agentDir,
        area: 'packages',
        summary: 'Review these hooks.',
        hookProject: project,
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).approvalId as string;
  }
  await setHooks(' '.repeat(40));
  const id = await seed();
  await basePage.page.setViewportSize({ width: 390, height: 844 });
  await basePage.page.goto('/activity');
  await basePage.waitForAppReady();
  await basePage.page.getByTestId('inbox-bell').click();
  let card = basePage.page.locator(`[data-approval-id="${id}"]`).last();
  const heading = card.getByRole('heading', {
    name: 'lunar-hooks wants to run code on this computer',
  });
  await expect(heading).toBeFocused();
  await expect(card.getByText('2 hooks', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow these 2 hooks' })).toBeVisible();
  await expect(card.getByRole('img', { name: '40 spaces' })).toHaveCount(1);
  await expect(card.getByText(/--label/)).toContainText('40 spaces');
  await expect(card.getByText(`"${project}"`, { exact: true })).toHaveCount(2);
  await expect(card.getByRole('region', { name: 'Hook details' })).toContainText(/"[a-f0-9]{64}"/u);
  await basePage.page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(
      async () =>
        (await card.locator('[data-slot="approval-card"]').boundingBox())?.width ?? Infinity
    )
    .toBeLessThanOrEqual(390);
  const allow = card.getByRole('button', { name: 'Allow these 2 hooks' });
  const decline = card.getByRole('button', { name: 'Decline' });
  expect((await decline.boundingBox())!.y).toBeGreaterThan((await allow.boundingBox())!.y);
  const body = card.getByRole('region', { name: 'Hook details' });
  await allow.scrollIntoViewIfNeeded();
  await expect(allow).toBeInViewport();
  await expect(decline).toBeInViewport();
  const buttonBefore = (await allow.boundingBox())!.y;
  await body.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(Math.abs((await allow.boundingBox())!.y - buttonBefore)).toBeLessThan(1);
  await expect(
    body.getByText('Files these commands load can change without asking again.')
  ).toBeVisible();
  await decline.click();
  await expect
    .poll(async () =>
      (await (await request.get('/api/approvals/pending')).json()).approvals.some(
        (row: { approvalId: string }) => row.approvalId === id
      )
    )
    .toBe(false);
  // The first decline stays as audit. A later incomplete review is a different outcome.
  await setHooks(' x '.repeat(1600));
  const incompleteId = await seed();
  await basePage.page.reload();
  await basePage.waitForAppReady();
  await basePage.page.getByTestId('inbox-bell').click();
  card = basePage.page.locator(`[data-approval-id="${incompleteId}"]`).last();
  await expect(card.getByRole('button')).toHaveText(['Decline']);
  await card.getByRole('button', { name: 'Decline' }).click();
  const row = basePage.page.locator(`[data-hook-review-id="${incompleteId}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Ask again' })).toBeVisible();
  await setHooks(' ');
  await row.getByRole('button', { name: 'Ask again' }).click();
  await expect(row.getByRole('status')).toContainText('Hooks stay off until you allow them.');
  const pending = basePage.page
    .locator('[data-approval-id]')
    .filter({ has: basePage.page.getByRole('button', { name: 'Allow these 2 hooks' }) })
    .last();
  await expect(pending).toBeVisible();
  const pendingId = await pending.getAttribute('data-approval-id');
  await pending.getByRole('button', { name: 'Allow these 2 hooks' }).click();
  await expect(
    basePage.page.locator(`[data-approval-id="${pendingId}"]`).last().getByText('Allowed once')
  ).toBeVisible();
  await expect(row).toHaveCount(0);
});
