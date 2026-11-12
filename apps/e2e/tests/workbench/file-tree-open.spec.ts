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

  test('a room file put back on the canvas after its tab was closed opens its tab again', async ({
    page,
    roomsApi,
    rightPanel,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'file-share');
    await roomsApi.enableRepo(roomId, { 'brief.md': '# Room brief\n' });
    await page.goto(`/channels?id=${roomId}`);
    await page.getByTestId('bar-members-chip').click();
    const files = page.getByRole('region', { name: 'Room files' });
    const tab = rightPanel.header.getByRole('tab', { name: /brief\.md/ });

    const putOnCanvas = async () => {
      await clickFileName(page, 'brief.md', files);
      const dialog = page.getByRole('dialog', { name: 'brief.md', exact: true });
      await dialog.getByRole('button', { name: 'Put on the canvas' }).click();
      await expect(dialog).toBeHidden();
    };

    await putOnCanvas();
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Close brief.md view' }).click();
    await expect(tab).toBeHidden();

    // Back to the room's own tab, where the Files list lives, and share it again.
    await rightPanel.header.getByRole('tab', { name: 'Room', exact: true }).click();
    await putOnCanvas();
    // The bug: the close was remembered, so the tab never came back.
    await expect(tab).toBeVisible();
  });

  test('a room tree shows a picture as a picture, and an SVG as text', async ({
    page,
    roomsApi,
    request,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'file-picture');
    const commit = await roomsApi.enableRepo(roomId, {
      'mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
    });
    const upload = await request.post(`/api/rooms/${roomId}/files/upload`, {
      multipart: {
        dir: '',
        baseCommit: commit!,
        files: { name: 'sample.png', mimeType: 'image/png', buffer: PNG },
      },
    });
    expect(upload.ok(), await upload.text()).toBe(true);

    await page.goto(`/channels?id=${roomId}`);
    await page.getByTestId('bar-members-chip').click();
    const files = page.getByRole('region', { name: 'Room files' });

    await clickFileName(page, 'sample.png', files);
    const pictureDialog = page.getByRole('dialog', { name: 'sample.png', exact: true });
    const picture = pictureDialog.getByRole('img', { name: 'sample.png' });
    await expect(picture).toBeVisible();
    await expect
      .poll(() => picture.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBe(1);
    await pictureDialog.getByRole('button', { name: 'Close', exact: true }).click();

    await clickFileName(page, 'mark.svg', files);
    const svgDialog = page.getByRole('dialog', { name: 'mark.svg', exact: true });
    await expect(svgDialog.getByText('<script>alert(1)</script>', { exact: false })).toBeVisible();
    await expect(svgDialog.getByRole('img')).toHaveCount(0);
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
