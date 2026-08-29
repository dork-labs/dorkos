import path from 'path';
import type { Page } from '@playwright/test';
import { API_URL, FLEET_ROOT, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import { patch, shoot, url, WAIT_MS } from './lib.js';

/**
 * The `room-files` drive: a channel whose files section is open, showing
 * `ROOM.md` pinned above a couple of real, committed files and who last
 * touched each one (spec `project-rooms` §3.9).
 *
 * Split out of `surfaces-desktop.ts` for the same reason the power and fleet
 * surfaces are — one cohesive drive that owns its own real setup (a channel,
 * a repo, two saved files) rather than reusing `openLiveTurn`'s session
 * scaffolding, which this surface has no use for.
 *
 * @module capture/surfaces-desktop-rooms
 */

/** POST JSON and return the parsed body, throwing on a non-2xx response. */
async function postJson<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The commit a room's file currently sits at, or `null` when it does not exist yet. */
async function roomFileCommit(roomId: string, filePath: string): Promise<string | null> {
  const res = await fetch(
    `${API_URL}/api/rooms/${roomId}/files/content?path=${encodeURIComponent(filePath)}`
  );
  if (!res.ok) return null;
  return ((await res.json()) as { commit: string }).commit;
}

/**
 * Save one of a room's files as the operator — the same `PUT` a person's save
 * makes, base-committed against whatever the file holds right now (or `null`
 * for a file that does not exist yet).
 */
async function writeRoomFile(roomId: string, filePath: string, text: string): Promise<void> {
  const baseCommit = await roomFileCommit(roomId, filePath);
  const res = await fetch(`${API_URL}/api/rooms/${roomId}/files/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath, baseCommit, text }),
  });
  if (!res.ok) {
    throw new Error(`Could not save ${filePath} in room ${roomId}: ${await res.text()}`);
  }
}

/** The channel's `#slug`, unique among this run's rooms. */
const ROOM_FILES_SLUG = 'release-train';

/** A second file beyond the auto-created `ROOM.md`, so the listing shows more than one row. */
const DEPLOY_CHECKLIST_MD =
  '# Deploy checklist\n\n' +
  '- [ ] Cut the release branch\n' +
  '- [ ] Run the smoke suite\n' +
  '- [ ] Tag and publish\n' +
  '- [ ] Post the release notes here\n';

/** A third file, so the room reads as a working channel rather than a fresh demo. */
const ROLLBACK_PLAN_MD =
  '# Rollback plan\n\n' +
  'If the smoke suite reds after publish, revert the tag and re-run the previous ' +
  'build before anybody re-tries the release.\n';

/**
 * Give a room files of its own and put a couple of real, committed files in
 * them — the same two calls a person's flow makes: `POST /repo` (operator-only,
 * committed as the operator) then a `PUT` per file. Returns the room id.
 */
async function seedRoomWithFiles(): Promise<string> {
  // A name on the commits, rather than the generic fallback — the provenance
  // column is the whole point of this shot, so it should read as a person's
  // name rather than "DorkOS operator".
  await patch('/api/config', { profile: { displayName: 'Dorian' } });

  const room = await postJson<{ id: string }>('/api/rooms', {
    kind: 'channel',
    slug: ROOM_FILES_SLUG,
    title: 'Release train',
    agentPaths: [path.join(FLEET_ROOT, 'atlas')],
  });
  await postJson(`/api/rooms/${room.id}/repo`, {});
  await writeRoomFile(room.id, 'DEPLOY.md', DEPLOY_CHECKLIST_MD);
  await writeRoomFile(room.id, 'ROLLBACK.md', ROLLBACK_PLAN_MD);
  return room.id;
}

/**
 * Drive the room-files money shot: seed a channel with a repo and a few real
 * commits, open its details panel, and wait for the Files section to have
 * drawn its provenance column.
 */
async function driveRoomFiles(page: Page): Promise<void> {
  const roomId = await seedRoomWithFiles();

  await page.goto(url(`/channels?id=${roomId}`));
  // The bar's member chip opens the room's details panel — the Files section
  // lives inside it (`RoomPanelBody`), not behind a route of its own.
  await page.getByTestId('bar-members-chip').click({ timeout: WAIT_MS });
  const sheet = page.getByRole('tabpanel');
  await sheet.waitFor({ state: 'visible', timeout: WAIT_MS });

  const files = sheet.getByRole('region', { name: 'Room files' });
  await files.waitFor({ timeout: WAIT_MS });
  const tree = files.getByRole('tree', { name: 'File explorer' });
  const rows = tree.getByRole('treeitem');
  await rows.first().waitFor({ timeout: WAIT_MS });

  // The money content: ROOM.md pinned first, its provenance column drawn —
  // "Dorian · just now" rather than a loading dash.
  const roomMdRow = rows.filter({ has: page.getByText('ROOM.md', { exact: true }) }).first();
  await roomMdRow.getByText(/ago|now/).waitFor({ timeout: WAIT_MS });
}

/** Capture the room-files surface: a channel's Files section, files pinned and attributed. */
export async function shootRoomFiles(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveRoomFiles(page);
  await shoot(page, 'room-files', theme, rec);
}
