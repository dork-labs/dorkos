/**
 * The apps this browser has seen register a page, kept so an app that stops
 * running (held, broken or off) keeps its tile instead of vanishing (DOR-3970).
 *
 * A held or off extension registers nothing, so the registry alone cannot say
 * it is an app. This remembers that it was. Browser storage, not config: it is
 * a cache of what this window saw, rebuilt by the next page that registers, and
 * losing it costs only the tile of an app that is not running anyway (a pinned
 * one keeps its row through its pin).
 *
 * @module entities/extension/model/known-apps
 */
import type { KnownApps } from '../lib/app-catalog';

/** The storage key. */
const KNOWN_APPS_KEY = 'dorkos:apps:known';

/** Read the remembered apps; an unreadable or malformed entry reads as none. */
export function readKnownApps(): KnownApps {
  try {
    const raw = localStorage.getItem(KNOWN_APPS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const known: Record<string, { name: string; path: string }> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { name?: unknown; path?: unknown } | null;
      if (typeof entry?.name === 'string' && typeof entry.path === 'string') {
        known[id] = { name: entry.name, path: entry.path };
      }
    }
    return known;
  } catch {
    return {};
  }
}

/**
 * Remember these apps, on top of what is already remembered. Returns the merged
 * set, or the same object when nothing changed.
 *
 * @param previous - What is remembered now.
 * @param seen - Apps that registered a page just now, by id.
 */
export function rememberApps(previous: KnownApps, seen: KnownApps): KnownApps {
  const changed = Object.entries(seen).some(
    ([id, entry]) => previous[id]?.name !== entry.name || previous[id]?.path !== entry.path
  );
  if (!changed) return previous;
  const next = { ...previous, ...seen };
  try {
    localStorage.setItem(KNOWN_APPS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the tile still draws this session from `next`.
  }
  return next;
}

/**
 * Forget apps that are no longer installed, so a removed app's tile does not
 * come back if an extension with its id is installed later and adds no page.
 *
 * @param previous - What is remembered now.
 * @param installedIds - Every extension id the server lists.
 */
export function forgetUninstalledApps(
  previous: KnownApps,
  installedIds: ReadonlySet<string>
): KnownApps {
  const kept = Object.entries(previous).filter(([id]) => installedIds.has(id));
  if (kept.length === Object.keys(previous).length) return previous;
  const next = Object.fromEntries(kept);
  try {
    localStorage.setItem(KNOWN_APPS_KEY, JSON.stringify(next));
  } catch {
    // As above.
  }
  return next;
}

/** The remembered apps, read once and kept for the session. */
let current: KnownApps | null = null;
const listeners = new Set<() => void>();

/** The remembered apps, read from storage the first time. */
export function getKnownApps(): KnownApps {
  current ??= readKnownApps();
  return current;
}

/**
 * Replace the remembered apps and tell every reader, when they changed.
 *
 * @param update - From what is remembered now to what should be.
 */
export function updateKnownApps(update: (previous: KnownApps) => KnownApps): void {
  const previous = getKnownApps();
  const next = update(previous);
  if (next === previous) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/**
 * Subscribe to {@link getKnownApps}.
 *
 * @param listener - Called after each change.
 */
export function subscribeKnownApps(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
