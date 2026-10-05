/**
 * The dev-link registry: `{dorkHome}/marketplace/dev-links.json` (DOR-2696).
 *
 * A dev link is a link in a package's normal slot plus one record here, which
 * DorkOS writes only on a person's yes. The record is what tells a dev link
 * apart from a link someone made by hand (DOR-2194): a slot counts as
 * dev-linked only while the record exists, the slot is a link, and the link
 * still resolves to the recorded folder (`isActiveDevLink`).
 *
 * Modelled on `lib/project-install-index.ts`: writes are serialised in this
 * process and land by an fsynced, atomic rename, and a file that does not
 * parse is refused by every reader (no slot counts as dev-linked) until the
 * next link moves it aside to `dev-links.json.corrupt-<time>`.
 *
 * @module services/marketplace/dev-links/registry
 */
import { lstat, mkdir, open, readFile, readlink, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  DEV_LINKS_FILE,
  isActiveDevLink,
  parseDevLinksFile,
  type DevLinkRecord,
  type DevLinkSlotReading,
  type DevLinkState,
} from '@dorkos/shared/marketplace-schemas';

/** What reading the registry found. */
export type DevLinksReading = { links: DevLinkRecord[] } | { unreadable: string };

/** Tail of the in-process write chain, per registry file. */
const writeChains = new Map<string, Promise<void>>();

/**
 * The registry file under a data directory.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 */
export function devLinksFilePath(dorkHome: string): string {
  return path.join(dorkHome, DEV_LINKS_FILE);
}

/**
 * Read every recorded dev link.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns `{ links }` (empty when nothing was ever recorded), or
 *   `{ unreadable }` with the reason when the file exists but cannot be read
 *   or parsed. A caller must never read that as "no dev links" and write over it.
 */
export async function readDevLinks(dorkHome: string): Promise<DevLinksReading> {
  const file = devLinksFilePath(dorkHome);
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { links: [] };
    return { unreadable: `Can't read ${file}: ${(err as Error).message}` };
  }
  const parsed = parseDevLinksFile(text);
  if (parsed === 'unreadable') return { unreadable: `Can't make sense of ${file}` };
  return { links: parsed.links };
}

/**
 * Read, change and durably rewrite the registry, one change at a time.
 *
 * A file that does not parse is moved aside to `dev-links.json.corrupt-<time>`
 * and replaced only when `replaceUnreadable` is set (the link path, which is
 * how the registry recovers); every other writer refuses rather than forget
 * records it could not read.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param change - Given the current records, returns the records to write.
 * @param opts.replaceUnreadable - Start fresh over an unparseable file.
 * @throws {Error} When the file is unreadable and `replaceUnreadable` is not set.
 */
export function updateDevLinks(
  dorkHome: string,
  change: (links: DevLinkRecord[]) => DevLinkRecord[] | Promise<DevLinkRecord[]>,
  opts: { replaceUnreadable?: boolean } = {}
): Promise<void> {
  const file = devLinksFilePath(dorkHome);
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    const reading = await readDevLinks(dorkHome);
    let current: DevLinkRecord[];
    if ('unreadable' in reading) {
      if (!opts.replaceUnreadable) throw new Error(reading.unreadable);
      await rename(file, `${file}.corrupt-${Date.now()}`);
      current = [];
    } else {
      current = reading.links;
    }
    const body = { version: 1 as const, links: await change(current) };
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, 'utf-8');
      // Durable before it replaces the old file, so a crash cannot leave a
      // renamed but empty registry.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  });
  writeChains.set(
    file,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * A slot path spelled canonically: its deepest existing ancestor resolved
 * through any links, its own name kept as it is. The slot itself is usually a link, so
 * resolving it too would name the developer's folder instead of the slot.
 *
 * @param slot - An absolute slot path.
 */
export async function canonicalSlotPath(slot: string): Promise<string> {
  const absolute = path.resolve(slot);
  const tail = [path.basename(absolute)];
  let current = path.dirname(absolute);
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Read what a slot looks like now, for `isActiveDevLink`.
 *
 * @param slot - The slot path.
 */
export async function readSlot(slot: string): Promise<DevLinkSlotReading> {
  const lstatIsLink = await lstat(slot)
    .then((stats) => stats.isSymbolicLink())
    .catch(() => false);
  const realpathOfSlot = await realpath(slot).catch(() => null);
  return { lstatIsLink, realpathOfSlot };
}

/**
 * The state of one recorded dev link on disk now. Never repairs anything.
 *
 * @param record - The registry record.
 */
export async function devLinkStateOf(
  record: Pick<DevLinkRecord, 'slot' | 'target'>
): Promise<DevLinkState> {
  const slot = await readSlot(record.slot);
  if (isActiveDevLink(record, slot)) return 'active';
  const present = await lstat(record.slot).then(
    () => true,
    () => false
  );
  if (!present) return 'link-missing';
  // A link still there whose text names the recorded folder, which is gone.
  if (slot.lstatIsLink && slot.realpathOfSlot === null) {
    const text = await readlink(record.slot).catch(() => null);
    if (text !== null && path.resolve(path.dirname(record.slot), text) === record.target) {
      return 'folder-missing';
    }
  }
  return 'link-replaced';
}

/**
 * The records of every dev link in force right now. An unreadable
 * registry yields none: no slot may count as dev-linked on a file nobody can
 * read.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 */
export async function activeDevLinks(dorkHome: string): Promise<DevLinkRecord[]> {
  const reading = await readDevLinks(dorkHome);
  if ('unreadable' in reading) return [];
  const active: DevLinkRecord[] = [];
  for (const record of reading.links) {
    if (isActiveDevLink(record, await readSlot(record.slot))) active.push(record);
  }
  return active;
}

/**
 * The recorded dev link whose link still sits in this slot (in force, or
 * pointing at a folder that has gone missing), or `null`. What install,
 * update and uninstall consult before touching a slot: each of them would
 * replace or delete the link, and unlink is the only way to switch back.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param slot - The install target, as the caller spells it.
 */
export async function devLinkInSlot(dorkHome: string, slot: string): Promise<DevLinkRecord | null> {
  const reading = await readDevLinks(dorkHome);
  if ('unreadable' in reading || reading.links.length === 0) return null;
  const canonical = await canonicalSlotPath(slot);
  const record = reading.links.find((link) => link.slot === canonical);
  if (!record) return null;
  const state = await devLinkStateOf(record);
  return state === 'active' || state === 'folder-missing' ? record : null;
}
