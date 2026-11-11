import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { draftSessionUrl } from '../../pages/session-draft';
import { seedRoom } from '../rooms/room-sheet-helpers';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=',
  'base64'
);

/**
 * Move to another page inside the app, the way a link does. A full `goto`
 * reloads the page and empties the stores the bug lives in.
 */
async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Click a file by its name, where a person clicks it (DOR-4179). */
async function clickFileName(page: Page, name: string, scope = page.locator('body')) {
  await scope
    .getByRole('treeitem', { name, exact: true })
    .locator('span', { hasText: name })
    .first()
    .click();
}

test.describe('Opening files from the tree @smoke', () => {
  test('an agent folder reopens a markdown file and an image after their tabs were closed', async ({
    page,
    roomsApi,
    rightPanel,
  }) => {
    const agent = await roomsApi.registerAgent(`File reader ${roomsApi.runId}`, '📁', '#6366f1');
    await writeFile(join(agent.path, 'brief.md'), '# Agent file preview\n');
    await writeFile(join(agent.path, 'sample.png'), PNG);
    await rightPanel.goto(await draftSessionUrl(page, randomUUID(), agent.path));

    for (const name of ['brief.md', 'sample.png']) {
      const tab = rightPanel.header.getByRole('tab', { name, exact: true });
      await rightPanel.selectView('Files');
      await clickFileName(page, name);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('button', { name: `Close ${name} view` }).click();
      await expect(tab).toBeHidden();

      // The click this ticket is about: the same file again, after its tab closed.
      await rightPanel.selectView('Files');
      await clickFileName(page, name);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    await expect(page.getByRole('img', { name: 'Canvas image' })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole('img', { name: 'Canvas image' })
          .evaluate((el) => (el as HTMLImageElement).naturalWidth)
      )
      .toBe(1);
    await rightPanel.header.getByRole('tab', { name: 'brief.md', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent file preview' })).toBeVisible();
  });

  test('a room tree never asks for the folders open in the agent folder before it', async ({
    page,
    roomsApi,
    rightPanel,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'file-open');
    await roomsApi.enableRepo(roomId, {
      'notes/brief.md': '# Room file preview\n\nA file opened from the tree.\n',
    });
    await mkdir(join(ana.path, 'changelog/unreleased'), { recursive: true });
    await writeFile(join(ana.path, 'changelog/unreleased/previous.md'), '# Previous folder\n');

    await rightPanel.goto(await draftSessionUrl(page, randomUUID(), ana.path));
    await rightPanel.selectView('Files');
    await page.getByRole('treeitem', { name: 'changelog', exact: true }).click();
    await page.getByRole('treeitem', { name: 'unreleased', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'previous.md', exact: true })).toBeVisible();

    const requestedPaths: Array<string | null> = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/rooms/${roomId}/files`) {
        requestedPaths.push(url.searchParams.get('path'));
      }
    });
    await navigateInApp(page, `/channels?id=${roomId}`);
    await page.getByTestId('bar-members-chip').click();
    const files = page.getByRole('region', { name: 'Room files' });
    await files.getByRole('treeitem', { name: 'notes', exact: true }).click();
    await clickFileName(page, 'brief.md', files);
    const markdown = page.getByRole('dialog', { name: 'brief.md', exact: true });
    await expect(markdown.getByRole('heading', { name: 'Room file preview' })).toBeVisible();

    expect(requestedPaths).toContain(null);
    expect(requestedPaths).not.toContain('changelog');
    expect(requestedPaths).not.toContain('changelog/unreleased');
  });
});
