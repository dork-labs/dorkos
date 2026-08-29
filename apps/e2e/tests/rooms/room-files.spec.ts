import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';
import { openSheet, seedRoom } from './room-sheet-helpers';

/**
 * A room's own files, in the browser: the explorer over them, and a person
 * changing one (spec `project-rooms` §3.9 E2E line, tasks 1.5 and 3.2).
 *
 * **This is the leg nothing below it can stand in for.** The unit suites cover
 * what each piece says; what they cannot cover is the trip a save actually
 * makes — React state, through the Transport port, through Express, into a real
 * `git commit` in a real checkout, and back as a real 409 whose payload the
 * dialog has to read. Every layer of that has its own idea of what a commit id
 * is, and the optimistic lock is exactly one string surviving all of them.
 *
 * The conflict is staged through the API rather than with a second browser: a
 * lost race is a fact about two versions of a file, and driving two windows to
 * produce it would add a second source of flake to test the same one commit.
 *
 * Nothing here starts an agent turn — every agent the fixture seeds is
 * silenced — so this spec costs no inference and is deterministic.
 *
 * **`{ exact: true }` on every "Saved" is load-bearing.** `getByText` with a
 * plain string matches a case-insensitive SUBSTRING, so `getByText('Saved')`
 * resolves against "Not saved yet" — the very state it is meant to wait for the
 * end of. Written without it, all three save assertions passed instantly and
 * then read the file back before the request had left the browser, which reads
 * as "the save did not land" against a product that was working.
 */
test.describe.configure({ mode: 'default', timeout: 90_000 });

/** What a room's `ROOM.md` says before anybody in this spec touches it. */
const SEEDED_ROOM_MD = '# House rules\n\nSay what you did.\n';

/**
 * A second file, so the listing has something to sort ROOM.md above.
 *
 * At the root, and not in a `notes/` folder: saving a room's file does not make
 * new folders (§3.10), so a seed that reached for one was refused
 * `ROOM_FILE_NOT_FOUND` — the same refusal a person would get, which is why the
 * seed goes through the real door rather than around it.
 */
const SEEDED_NOTE = '# Sizing\n\nRough, and probably wrong.\n';

test.describe('Room files — reading them, and changing one @smoke', () => {
  test('the explorer lists a room’s files, pins ROOM.md, and says who last touched each', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-read');
    await roomsApi.enableRepo(roomId, {
      'ROOM.md': SEEDED_ROOM_MD,
      'README.md': SEEDED_NOTE,
    });
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const files = sheet.getByRole('region', { name: 'Room files' });
    await expect(files).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const tree = files.getByRole('tree', { name: 'File explorer' });
    const rows = tree.getByRole('treeitem');
    await expect(rows.first()).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // **ROOM.md first, whatever the alphabet says.** `README.md` sorts ahead of
    // it in code-unit order, so a listing that merely sorted would put the
    // room's own rules second — and both are pinned above everything else.
    await expect(rows.nth(0)).toHaveAttribute('aria-label', 'ROOM.md');
    await expect(rows.nth(1)).toHaveAttribute('aria-label', 'README.md');
    await expect(files.getByLabel('Pinned to the top').first()).toBeVisible();

    // The provenance column: the one thing a commit knows and a filesystem
    // cannot. The name on it is the person who saved it — the seed went through
    // the same save door a person's edit does.
    const roomMdRow = rows.filter({ has: page.getByText('ROOM.md', { exact: true }) }).first();
    await expect(roomMdRow).toContainText(/ago|now/);
  });

  test('a person edits ROOM.md in the app and the room’s files really change', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-edit');
    await roomsApi.enableRepo(roomId, { 'ROOM.md': SEEDED_ROOM_MD });
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const files = sheet.getByRole('region', { name: 'Room files' });
    await files.getByRole('treeitem', { name: 'ROOM.md' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // The file is READ before it is editable: what the pencil hands over is the
    // text the room actually holds, not an empty box.
    await expect(dialog).toContainText('House rules');

    await dialog.getByRole('button', { name: 'Edit' }).click();
    const box = dialog.getByRole('textbox', { name: /ROOM\.md contents/ });
    await expect(box).toHaveValue(SEEDED_ROOM_MD);

    // Nothing typed, nothing to save: one save is one commit here.
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    const edited = `${SEEDED_ROOM_MD}\nAsk before you merge.\n`;
    await box.fill(edited);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // The claim is not that the UI said "Saved" — it is that the room's files
    // hold what was typed. Read back through the API, which is a different door
    // into the same git repo.
    expect(await roomsApi.readRoomFile(roomId, 'ROOM.md')).toBe(edited);
  });

  test('a save that lost the race offers the choice, and keeping mine lands it', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-conflict');
    await roomsApi.enableRepo(roomId, { 'ROOM.md': SEEDED_ROOM_MD });
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const files = sheet.getByRole('region', { name: 'Room files' });
    await files.getByRole('treeitem', { name: 'ROOM.md' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Edit' }).click();
    const box = dialog.getByRole('textbox', { name: /ROOM\.md contents/ });
    await expect(box).toHaveValue(SEEDED_ROOM_MD);

    // Somebody else lands a change to the same file while this editor is open.
    // The editor is now holding a commit the room has moved past — which is the
    // whole of the race, and there is no way to stage it from inside one window.
    const theirs = '# House rules\n\nAna got here first.\n';
    await roomsApi.writeRoomFile(roomId, 'ROOM.md', theirs);

    await box.fill('# House rules\n\nMine, typed slowly.\n');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Never a silent overwrite, and never a silent discard: the refusal is a
    // question with the other version's author on it.
    await expect(dialog.getByText(/changed this file while you were editing it/)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(dialog.getByRole('button', { name: 'Open their version' })).toBeVisible();
    // Nothing was written while that question is open.
    expect(await roomsApi.readRoomFile(roomId, 'ROOM.md')).toBe(theirs);

    await dialog.getByRole('button', { name: 'Save mine over it' }).click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // "Keep mine" means the commit the CONFLICT named goes back as the base —
    // sending the stale one would be refused forever, and the file would still
    // say Ana's line.
    expect(await roomsApi.readRoomFile(roomId, 'ROOM.md')).toBe(
      '# House rules\n\nMine, typed slowly.\n'
    );
  });

  test('taking their version replaces what was typed, and then saves clean', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'files-theirs');
    await roomsApi.enableRepo(roomId, { 'ROOM.md': SEEDED_ROOM_MD });
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const files = sheet.getByRole('region', { name: 'Room files' });
    await files.getByRole('treeitem', { name: 'ROOM.md' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Edit' }).click();
    const box = dialog.getByRole('textbox', { name: /ROOM\.md contents/ });
    await expect(box).toHaveValue(SEEDED_ROOM_MD);

    const theirs = '# House rules\n\nAna got here first.\n';
    await roomsApi.writeRoomFile(roomId, 'ROOM.md', theirs);
    await box.fill('# House rules\n\nMine, typed slowly.\n');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await dialog.getByRole('button', { name: 'Open their version' }).click();

    // The editor now holds their text AND their commit: the question is gone,
    // and Save is dark because what is in the box is what the room holds.
    await expect(box).toHaveValue(theirs);
    await expect(dialog.getByRole('button', { name: 'Open their version' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    // And an edit on top of theirs saves without another race, which is the
    // proof the base moved rather than the question merely being dismissed.
    await box.fill(`${theirs}\nAnd mine, after reading it.\n`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await roomsApi.readRoomFile(roomId, 'ROOM.md')).toBe(
      `${theirs}\nAnd mine, after reading it.\n`
    );
  });
});
