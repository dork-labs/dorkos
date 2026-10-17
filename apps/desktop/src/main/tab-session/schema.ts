import { z } from 'zod';

/**
 * The shape of the remembered tab session, and the rules that read it back.
 *
 * Everything here is untrusted on the way in: the file is hand-editable, an
 * older or newer build may have written it, and a renderer is a separate
 * process. So every read goes through these schemas, and anything that does not
 * fit is dropped rather than trusted. The renderer repairs what it is given a
 * second time (`readPersistedTabs` in the client's tab store), so this side only
 * has to make sure nothing malformed is ever written back to disk.
 *
 * @module main/tab-session/schema
 */

/**
 * The file format's version. Bump it when the shape changes in a way an older
 * reader would misread; a file with any other version is set aside and the app
 * opens on one home tab.
 */
export const TAB_SESSION_VERSION = 1;

/**
 * How long an unpinned tab can go unseen before launch stops reopening it. It
 * goes to Recently closed instead, so it is one click away rather than gone.
 * Pinned tabs never age out. A setting can come later; the rule stays here.
 */
export const STALE_TAB_MS = 7 * 24 * 60 * 60 * 1000;

/** How many closed tabs Recently closed remembers. The oldest drop off. */
export const MAX_RECENTLY_CLOSED = 25;

/** Most tabs one window may carry. Far past any real use; a bound on a bad file. */
const MAX_TABS_PER_WINDOW = 500;

/** Most windows the file may carry. Same reasoning. */
const MAX_WINDOWS = 20;

/** Longest href kept. A location is a short router path, never a document. */
const MAX_HREF_LENGTH = 8_192;

/** A router-relative location: starts with one `/`, never `//host`. */
const HrefSchema = z
  .string()
  .min(1)
  .max(MAX_HREF_LENGTH)
  .refine((href) => href.startsWith('/') && !href.startsWith('//'), 'not a relative path');

/** One tab, as the renderer's store holds it (`AppTab` in the client). */
export const TabSchema = z.object({
  id: z.string().min(1).max(200),
  href: HrefSchema,
  history: z.array(HrefSchema).min(1).max(50),
  cursor: z.number().int().nonnegative(),
  pinned: z.boolean().optional(),
  /** When the tab was last on screen, ms since the epoch. Absent reads as "now". */
  lastViewedAt: z.number().finite().nonnegative().optional(),
});

/** One remembered tab. */
export type SavedTab = z.infer<typeof TabSchema>;

/** One window's tabs and which one is in front. */
export const WindowTabsSchema = z.object({
  tabs: z.array(TabSchema).min(1).max(MAX_TABS_PER_WINDOW),
  activeTabId: z.string().nullable(),
});

/** One window's tabs and which one is in front. */
export type WindowTabs = z.infer<typeof WindowTabsSchema>;

/** A tab in Recently closed: the tab itself, where it sat, and when it went. */
export const ClosedTabSchema = z.object({
  tab: TabSchema,
  /** Its index in the strip when it closed, so reopening puts it back there. */
  index: z.number().int().nonnegative(),
  closedAt: z.number().finite().nonnegative(),
});

/** A tab in Recently closed. */
export type ClosedTab = z.infer<typeof ClosedTabSchema>;

/** What happens when DorkOS opens after a normal quit. */
export const StartupModeSchema = z.enum(['reopen', 'fresh']);

/** What happens when DorkOS opens after a normal quit. */
export type StartupMode = z.infer<typeof StartupModeSchema>;

/** The whole file. */
export const TabSessionFileSchema = z.object({
  version: z.literal(TAB_SESSION_VERSION),
  /** False from launch until a quit finishes. Still false on the next launch means it crashed. */
  cleanExit: z.boolean(),
  /** True when the app itself asked to restart: an update, a recovery, a move. */
  relaunch: z.boolean(),
  startup: StartupModeSchema,
  windows: z.array(WindowTabsSchema).max(MAX_WINDOWS),
  recentlyClosed: z.array(ClosedTabSchema).max(MAX_RECENTLY_CLOSED),
});

/** The whole file. */
export type TabSessionFile = z.infer<typeof TabSessionFileSchema>;

/** A file with nothing in it: the first launch, or what a bad file is replaced by. */
export function emptyTabSession(): TabSessionFile {
  return {
    version: TAB_SESSION_VERSION,
    cleanExit: true,
    relaunch: false,
    startup: 'reopen',
    windows: [],
    recentlyClosed: [],
  };
}

/**
 * Make one window's tabs internally consistent: a cursor that points at its
 * href, and an active id that names a tab. A tab whose history does not hold
 * its href keeps the tab and restarts its history there, the same repair the
 * renderer applies, because losing a Back stack is a shrug and losing a tab is
 * not.
 */
function repairWindow(win: WindowTabs): WindowTabs {
  const tabs = win.tabs.map((tab) =>
    tab.history[tab.cursor] === tab.href ? tab : { ...tab, history: [tab.href], cursor: 0 }
  );
  const activeTabId = tabs.some((tab) => tab.id === win.activeTabId) ? win.activeTabId : tabs[0].id;
  return { tabs, activeTabId };
}

/**
 * Read one window's tabs from an untrusted value (the file, or a renderer).
 *
 * @param raw - Anything.
 * @returns The window, repaired, or `null` when it is not one.
 */
export function parseWindowTabs(raw: unknown): WindowTabs | null {
  const parsed = WindowTabsSchema.safeParse(raw);
  return parsed.success ? repairWindow(parsed.data) : null;
}

/**
 * Read the file's contents.
 *
 * Any failure (bad JSON was already caught by the caller; here a wrong
 * version, a wrong shape) answers `null`, and the caller starts from
 * {@link emptyTabSession}. All or nothing on purpose: half-trusting a file we
 * cannot read is how a bad write becomes a bad launch every time.
 *
 * @param raw - The parsed JSON.
 */
export function parseTabSessionFile(raw: unknown): TabSessionFile | null {
  const parsed = TabSessionFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, windows: parsed.data.windows.map(repairWindow) };
}
