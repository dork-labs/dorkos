/**
 * Which installed extensions are apps, and what each one says right now — the
 * one answer the sidebar's Apps door, the Apps page and ⌘K all draw from
 * (DOR-3970).
 *
 * **An app is an extension that adds a page.** A running one proves it by
 * registering one. One that is not running (held, broken or off) registers
 * nothing, so it is known from the last time it did ({@link KnownApps}) or from
 * a pin, and keeps its place instead of vanishing.
 *
 * Pure, so every state is a table test.
 *
 * @module entities/extension/lib/app-catalog
 */
import type { ExtensionPageBadge, ExtensionRecordPublic } from '@dorkos/extension-api';

/**
 * What one app is doing, as a tile, a pinned row and ⌘K all show it.
 *
 * - `ok` — running; opens.
 * - `held` — waiting on a person: never allowed, or its files changed since
 *   (“Needs your OK”). Opens its approval card, never approves.
 * - `error` — on and allowed, but its screens failed to build or start
 *   (“Not working”). Pressing it retries.
 * - `off` — a person turned it off. Opens its Settings row.
 */
export type AppState = 'ok' | 'held' | 'error' | 'off';

/** One app, ready to draw. */
export interface AppEntry {
  /** The extension id. */
  id: string;
  /** Its name, as the person reads it. */
  name: string;
  /** What it does, for search only: never drawn on a tile. */
  summary: string;
  /** What it is doing. */
  state: AppState;
  /** The page a press opens: its home (`''`) when it has one, else its first listed page. */
  path: string;
  /** The page's contribution id (`<id>:<path>`) while it is registered, for its icon; else `null`. */
  pageId: string | null;
  /** The app's own count of things waiting, from its page badge; 0 for none. */
  count: number;
  /** The app's own one live line, from its page badge, or `null`. */
  line: string | null;
}

/** What the person last saw of an app that registered a page, by extension id. */
export type KnownApps = Readonly<Record<string, { name: string; path: string }>>;

/** One listed page, as the catalog reads it. */
export interface CatalogPage {
  /** The page's contribution id, `<extensionId>:<path>`. */
  id: string;
  /** The extension that registered it. */
  extensionId: string;
  /** The path it registered. */
  path: string;
  /** Its title. */
  title: string;
}

/** Whether the list could be read. */
export type AppCatalogStatus = 'loading' | 'failed' | 'ready';

/** The whole answer. */
export interface AppCatalog {
  /** `failed` is never “no apps”: the surfaces say so and offer Try again. */
  status: AppCatalogStatus;
  /** Every app, A–Z by name. Empty unless `status` is `ready`. */
  apps: readonly AppEntry[];
}

/** Everything {@link buildAppCatalog} reads. */
export interface AppCatalogInput {
  /** The extension list, or `undefined` before its first answer. */
  extensions: readonly ExtensionRecordPublic[] | undefined;
  /** Whether the list, or loading the extensions it names, failed. */
  failed: boolean;
  /** The ids of extensions waiting on a person (the pending approvals). */
  waitingIds: ReadonlySet<string>;
  /** The pages that asked to be listed, by title. */
  pages: readonly CatalogPage[];
  /** Page badges, by contribution id. */
  badges: Readonly<Record<string, ExtensionPageBadge>>;
  /** Apps seen before. */
  known: KnownApps;
  /** Pinned app ids. A pinned id is an app even when nothing else says so. */
  pins: readonly string[];
}

/** Statuses of an extension a person turned off. */
const OFF_STATUSES = new Set(['disabled', 'discovered']);
/** Statuses whose screens failed to build or start. */
const ERROR_STATUSES = new Set(['compile_error', 'activate_error']);
/**
 * Statuses that are never a tile. They read “Can’t load” or “Needs newer
 * DorkOS”, which live in Settings only (spec §10).
 */
const SETTINGS_ONLY_STATUSES = new Set(['invalid', 'incompatible']);

/**
 * What one extension is doing, as an app.
 *
 * @param ext - The extension record.
 * @param waiting - Whether a person has been asked about it and not answered.
 */
export function appState(ext: ExtensionRecordPublic, waiting: boolean): AppState {
  if (OFF_STATUSES.has(ext.status)) return 'off';
  if (waiting || (ext.origin === 'user' && !ext.approvedToRun)) return 'held';
  if (ERROR_STATUSES.has(ext.status)) return 'error';
  return 'ok';
}

/**
 * Each extension's first listed page: its home when it has one, else the
 * first by title (the order `pages` arrives in).
 *
 * @param pages - The listed pages.
 */
export function firstPages(pages: readonly CatalogPage[]): Map<string, CatalogPage> {
  const first = new Map<string, CatalogPage>();
  for (const page of pages) {
    const seen = first.get(page.extensionId);
    if (seen === undefined || (page.path === '' && seen.path !== '')) {
      first.set(page.extensionId, page);
    }
  }
  return first;
}

/**
 * The apps, A–Z.
 *
 * @param input - What the catalog reads ({@link AppCatalogInput}).
 */
export function buildAppCatalog(input: AppCatalogInput): AppCatalog {
  if (input.failed) return { status: 'failed', apps: [] };
  if (input.extensions === undefined) return { status: 'loading', apps: [] };
  const first = firstPages(input.pages);
  const apps: AppEntry[] = [];
  for (const ext of input.extensions) {
    const page = first.get(ext.id);
    const known = input.known[ext.id];
    if (page === undefined && known === undefined && !input.pins.includes(ext.id)) continue;
    if (SETTINGS_ONLY_STATUSES.has(ext.status)) continue;
    const badge = page ? input.badges[page.id] : undefined;
    apps.push({
      id: ext.id,
      name: ext.manifest.name || page?.title || known?.name || ext.id,
      summary: ext.manifest.purpose ?? ext.manifest.description ?? '',
      state: appState(ext, input.waitingIds.has(ext.id)),
      path: page?.path ?? known?.path ?? '',
      pageId: page?.id ?? null,
      count: badge?.count ?? 0,
      line: badge?.sentence?.trim() || null,
    });
  }
  apps.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  );
  return { status: 'ready', apps };
}

/**
 * The pinned apps, in pin order. An `off` app is left out (turning it back
 * on brings its row back); a pin whose app is gone is skipped.
 *
 * @param apps - The catalog's apps.
 * @param pins - Pinned ids, in pin order.
 */
export function pinnedApps(apps: readonly AppEntry[], pins: readonly string[]): AppEntry[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  return pins.flatMap((id) => {
    const app = byId.get(id);
    return app && app.state !== 'off' ? [app] : [];
  });
}

/**
 * Whether an app matches a search: its name or its summary (spec §3: the
 * summary is searched, never shown).
 *
 * @param app - The app.
 * @param query - What the person typed. Blank matches everything.
 */
export function matchesAppSearch(app: AppEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [app.name, app.summary].some((text) => text.toLocaleLowerCase().includes(needle));
}

/**
 * The accessible name of a tile, row or ⌘K item: the name, then its state in
 * words, because the dot or pill beside it is hidden from screen readers.
 *
 * @param app - The app.
 */
export function appAccessibleName(app: AppEntry): string {
  if (app.state === 'held') return `${app.name}, needs your OK`;
  if (app.state === 'error') return `${app.name}, not working. Try again`;
  if (app.state === 'off') return `${app.name}, off`;
  if (app.count > 0) return `${app.name}, ${app.count} waiting`;
  return app.name;
}
