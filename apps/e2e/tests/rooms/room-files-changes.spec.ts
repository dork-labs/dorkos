import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';
import { touchHeight, TOUCH_TARGET_PX } from '../../pages/touch-reach';
import { openSheet, PHONE, seedRoom } from './room-sheet-helpers';

/**
 * A person changing a room's files from the Files panel, in the browser (spec
 * `agent-home-desk` §11, Browser): upload by drag, rename, delete a folder
 * through the confirmation, edit a `.ts` file, keep a chat attachment in the
 * room's files — each one showing its quiet line in the room and the tree
 * refreshing to match.
 *
 * **The leg nothing below it can stand in for.** The unit suites pin what each
 * piece says with a mock transport; what they cannot pin is the trip — a real
 * drop event, a real multipart body through Express into a real `git commit`,
 * the room entry that commit posts arriving on the stream, and the tree reading
 * the new commit back. Every assertion that matters is read back through the
 * API as well, which is a different door into the same repo.
 *
 * Nothing here starts an agent turn — every agent the fixture seeds is silenced,
 * and a file-change entry addresses nobody — so this spec costs no inference.
 */
test.describe.configure({ mode: 'default', timeout: 90_000 });

/** The Files section of an open room panel. */
function filesOf(sheet: Locator): Locator {
  return sheet.getByRole('region', { name: 'Room files' });
}

/**
 * Open a row's menu the way a person's right-click does on a Mac: the menu
 * opens on the press, and the release comes after it is up.
 *
 * **Not `click({ button: 'right' })`.** That presses and releases in the same
 * instant at the row's centre, and a row low in the panel gets its menu shifted
 * up over the pointer to fit the window — so the release lands on whichever
 * item is under it, and Radix takes a release on an item as choosing it (the
 * first run chose "Upload files…" and opened the file picker). Releasing on
 * the menu's own backdrop, once it is open, is the gesture being tested.
 */
async function openRowMenu(row: Locator): Promise<void> {
  const page = row.page();
  const box = await row.boundingBox();
  if (box === null) throw new Error('The row is not on screen');
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  // Away from the menu before letting go, so the release chooses nothing.
  await page.mouse.move(box.x - 120, box.y + box.height / 2);
  await page.mouse.up({ button: 'right' });
}

/**
 * Whether the keyboard is in the tree — on the tree itself or on one of its
 * rows. Where it must NOT be is `<body>`, where a dialog with no trigger to
 * return to used to leave it.
 */
async function expectFocusInTree(tree: Locator): Promise<void> {
  await expect
    .poll(() =>
      tree.evaluate((el) => {
        const active = document.activeElement;
        return active !== null && el.contains(active)
          ? 'in tree'
          : (active?.outerHTML.slice(0, 80) ?? 'none');
      })
    )
    .toBe('in tree');
}

/** One room entry about a file change, by what it says. */
function fileChangeLine(page: Page, text: RegExp): Locator {
  return page.getByTestId('room-entry-file-change').filter({ hasText: text });
}

/**
 * Drop files from "outside the app" onto an element — a synthetic drop carrying
 * a real `DataTransfer` of real `File`s, which is exactly what the browser hands
 * a page when somebody drags from the desktop.
 */
async function dropFiles(
  target: Locator,
  files: Array<{ name: string; type: string; text: string }>
): Promise<void> {
  const dataTransfer = await target.page().evaluateHandle((specs) => {
    const data = new DataTransfer();
    for (const spec of specs) data.items.add(new File([spec.text], spec.name, { type: spec.type }));
    return data;
  }, files);
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
}

/**
 * Post a message carrying one file, the way the composer does it: upload the
 * bytes to the room, then post the entry that names them.
 */
async function postAttachment(
  roomsApi: RoomsApi,
  page: Page,
  roomId: string,
  file: { name: string; type: string; text: string }
): Promise<void> {
  const upload = await page.request.post(`/api/rooms/${roomId}/attachments`, {
    multipart: {
      files: { name: file.name, mimeType: file.type, buffer: Buffer.from(file.text) },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const { attachments } = (await upload.json()) as { attachments: Array<{ id: string }> };
  const post = await page.request.post(`/api/rooms/${roomId}/entries`, {
    data: { text: 'Here is the brief', attachmentIds: [attachments[0].id] },
  });
  expect(post.status(), await post.text()).toBe(202);
  await roomsApi.waitForEntry(
    roomId,
    (entry) => entry.body.text === 'Here is the brief',
    'the message carrying the attachment'
  );
}

test.describe('Room files — changing them from the Files panel', () => {
  test('files dropped on the panel are uploaded as one change, and a taken name is asked about', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-upload');
    await roomsApi.enableRepo(roomId, { 'README.md': '# Readme\n' });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });
    await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    await dropFiles(tree, [
      { name: 'plan.md', type: 'text/markdown', text: '# Plan\n' },
      { name: 'notes.txt', type: 'text/plain', text: 'first notes\n' },
    ]);

    // A second drop straight after, while the first is still landing, onto a
    // name the room already has. It is asked about — the first upload's refresh
    // once cancelled the read this question needs, and the person was told
    // their upload had failed.
    await dropFiles(tree, [{ name: 'README.md', type: 'text/markdown', text: '# Mine\n' }]);
    const choice = page.getByRole('alertdialog');
    await expect(choice).toContainText('Replace “README.md”?', { timeout: SERVER_ROUND_TRIP_MS });
    await choice.getByRole('button', { name: 'Replace' }).click();

    await expect(tree.getByRole('treeitem', { name: 'plan.md' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
    await expect(fileChangeLine(page, /uploaded 2 files to the top folder/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'plan.md')).toBe('# Plan\n');
    expect(await roomsApi.readRoomFile(roomId, 'notes.txt')).toBe('first notes\n');
    await expect
      .poll(() => roomsApi.readRoomFile(roomId, 'README.md'), { timeout: SERVER_ROUND_TRIP_MS })
      .toBe('# Mine\n');
    await expect(fileChangeLine(page, /uploaded README\.md to the top folder/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('a rename from the row menu lands, and the tree and the room both say so', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-rename');
    await roomsApi.enableRepo(roomId, { 'draft.md': '# Draft\n' });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });

    await openRowMenu(tree.getByRole('treeitem', { name: 'draft.md' }));
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const input = tree.getByRole('textbox', { name: 'New name' });
    await expect(input).toBeFocused();
    await input.fill('final.md');
    await input.press('Enter');

    await expect(tree.getByRole('treeitem', { name: 'final.md' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // Enter renamed the file and did NOT also open it.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(fileChangeLine(page, /renamed draft\.md to final\.md/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'final.md')).toBe('# Draft\n');
    expect(await roomsApi.readRoomFile(roomId, 'draft.md')).toBeNull();
  });

  test('deleting a folder asks first, names how many files go, and then removes them', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-delete');
    // Every file sits a folder deeper than the folder being deleted — the
    // room's line still has to name `old/`, not the folder its files were in.
    await roomsApi.enableRepo(roomId, {
      'old/sub/a.md': 'a\n',
      'old/sub/b.md': 'b\n',
    });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });

    // Backing out hands the keyboard back to the tree, not to the page.
    await openRowMenu(tree.getByRole('treeitem', { name: 'old' }));
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expectFocusInTree(tree);

    await openRowMenu(tree.getByRole('treeitem', { name: 'old' }));
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Delete this folder?');
    await expect(confirm).toContainText('“old” and the 2 files in it leave the room’s files.', {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(confirm).toContainText('The room’s history keeps a copy');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expectFocusInTree(tree);

    await expect(tree.getByRole('treeitem', { name: 'old' })).toHaveCount(0, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(fileChangeLine(page, /deleted old\/$/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'old/sub/a.md')).toBeNull();
  });

  test('a rename over somebody’s newer change asks, and "anyway" lands it with the cursor kept', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-race');
    await roomsApi.enableRepo(roomId, { 'draft.md': '# Draft\n' });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });
    await expect(tree.getByRole('treeitem', { name: 'draft.md' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // Somebody else changes the file after this tree was read — and the tree
    // is held at the version it read, as it is for a person who has not looked
    // again yet. (Left alone it would refresh on the room's own line about the
    // change, and there would be no race left to lose.)
    const seen = await (await page.request.get(`/api/rooms/${roomId}/files`)).json();
    await page.route(
      (url) => url.pathname.endsWith(`/rooms/${roomId}/files`),
      (route) => route.fulfill({ json: seen })
    );
    await roomsApi.writeRoomFile(roomId, 'draft.md', '# Draft, by Ana\n');

    await openRowMenu(tree.getByRole('treeitem', { name: 'draft.md' }));
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const input = tree.getByRole('textbox', { name: 'New name' });
    await expect(input).toBeFocused();
    await input.fill('final.md');
    await input.press('Enter');

    const choice = page.getByRole('alertdialog');
    await expect(choice).toContainText('after you opened it, so nothing was renamed', {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await choice.getByRole('button', { name: 'Rename it anyway' }).click();
    await expectFocusInTree(tree);

    await expect(fileChangeLine(page, /renamed draft\.md to final\.md$/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'final.md')).toBe('# Draft, by Ana\n');
  });

  test('a folder moved deeper is named where it went, whatever depth its files are at', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-move-deep');
    await roomsApi.enableRepo(roomId, { 'a/f.md': 'f\n' });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });

    await openRowMenu(tree.getByRole('treeitem', { name: 'a' }));
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const input = tree.getByRole('textbox', { name: 'New name' });
    await expect(input).toBeFocused();
    await input.fill('x/y/a');
    await input.press('Enter');

    await expect(fileChangeLine(page, /renamed a\/ to x\/y\/a\/$/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'x/y/a/f.md')).toBe('f\n');
  });

  test('an archived room offers its files to read and nothing to change them with', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-archived');
    await roomsApi.enableRepo(roomId, { 'README.md': '# Readme\n' });
    await postAttachment(roomsApi, page, roomId, {
      name: 'brief.txt',
      type: 'text/plain',
      text: 'The brief.\n',
    });
    await roomsApi.archive(roomId);
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });
    await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    for (const name of ['New file', 'New folder', 'Upload files']) {
      await expect(files.getByRole('button', { name })).toHaveCount(0);
    }
    await tree.getByRole('treeitem', { name: 'README.md' }).click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('room-entry-attachments')).toBeVisible();
    await expect(page.getByRole('button', { name: /to the room’s files/ })).toHaveCount(0);
  });

  test('a .ts file is edited in the same editor markdown is, and saved as one change', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-edit-ts');
    await roomsApi.enableRepo(roomId, { 'src/index.ts': 'export const answer = 41;\n' });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));
    const tree = files.getByRole('tree', { name: 'File explorer' });

    await tree.getByRole('treeitem', { name: 'src' }).click();
    await tree.getByRole('treeitem', { name: 'index.ts' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Edit' }).click();
    const box = dialog.getByRole('textbox', { name: 'index.ts contents' });
    await expect(box).toHaveValue('export const answer = 41;\n');
    await box.fill('export const answer = 42;\n');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    expect(await roomsApi.readRoomFile(roomId, 'src/index.ts')).toBe('export const answer = 42;\n');
    await expect(fileChangeLine(page, /edited src\/index\.ts/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('a file attached in the chat is kept in the room’s files', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-attachment');
    await roomsApi.enableRepo(roomId, { 'README.md': '# Readme\n' });
    await postAttachment(roomsApi, page, roomId, {
      name: 'brief.txt',
      type: 'text/plain',
      text: 'The brief, attached.\n',
    });
    await openCockpit(basePage);
    const files = filesOf(await openSheet(page, roomId));

    await page.getByRole('button', { name: 'Save brief.txt to the room’s files' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to room files' });
    await dialog.getByRole('button', { name: 'Save to the top folder' }).click();
    await expect(dialog).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });

    await expect(files.getByRole('treeitem', { name: 'brief.txt' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(
      fileChangeLine(page, /saved brief\.txt from the chat to the top folder/)
    ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    expect(await roomsApi.readRoomFile(roomId, 'brief.txt')).toBe('The brief, attached.\n');
  });
});

test.describe('Room files — on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the ways to add a file are big enough for a thumb', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-phone');
    await roomsApi.enableRepo(roomId, { 'README.md': '# Readme\n' });
    await postAttachment(roomsApi, page, roomId, {
      name: 'brief.txt',
      type: 'text/plain',
      text: 'The brief.\n',
    });
    await openCockpit(basePage);

    await page.goto(`/channels?id=${roomId}`);
    const save = page.getByRole('button', { name: 'Save brief.txt to the room’s files' });
    await expect(save).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    expect(await touchHeight(save)).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);

    const files = filesOf(await openSheet(page, roomId));
    for (const name of ['New file', 'New folder', 'Upload files']) {
      const button = files.getByRole('button', { name });
      await expect(button).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      const height = await touchHeight(button);
      expect(height, `${name} is ${height}px tall`).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    }
  });
});
