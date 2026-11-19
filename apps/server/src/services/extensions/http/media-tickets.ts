/**
 * Media tickets: how an app's frame plays a long video from its own route
 * (DOR-4321, Security 2026-11-18).
 *
 * A frame is an opaque origin and carries no cookie, so its `<video>` cannot
 * load `/api/ext/<id>/…` itself. The person's window asks for a ticket instead
 * (`routes/extension-media.ts`), and the frame's `<video>` loads
 * `/api/extensions/media/<ticket>`, which lets the browser fetch ranges and
 * seek on its own.
 *
 * A ticket is 32 random bytes, kept in this process only, and names one
 * extension and one path below its mount, normalized once when it is minted
 * and matched exactly. It carries no person, no session and no agent. It
 * lasts 10 minutes after its last use and 2 hours at most, an extension keeps
 * at most 16 (the oldest goes first), and every ticket of an extension goes
 * when it stops, reloads or updates.
 *
 * @module services/extensions/http/media-tickets
 */
import { randomBytes } from 'node:crypto';

/** Where a ticket is served, the ticket after it. */
export const MEDIA_URL_PREFIX = '/api/extensions/media/';

/** How long a ticket lasts without being used. */
export const MEDIA_TICKET_IDLE_MS = 10 * 60 * 1000;

/** How long a ticket lasts at most, used or not. */
export const MEDIA_TICKET_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The most live tickets one extension keeps; a new one past it drops the oldest. */
export const MAX_MEDIA_TICKETS_PER_APP = 16;

/** What one ticket is bound to. */
export interface MediaTicketTarget {
  /** The extension whose route it plays. */
  readonly extensionId: string;
  /** The normalized path below the extension's mount, e.g. `/videos/intro.mp4`. */
  readonly subPath: string;
  /**
   * The running instance it was minted for, compared by identity when it is
   * used: a ticket minted while an extension was stopping never plays from the
   * code that replaced it.
   */
  readonly instance: object;
}

interface TicketRecord extends MediaTicketTarget {
  mintedAt: number;
  usedAt: number;
}

/** Every live ticket, oldest first (a `Map` keeps insertion order). */
const tickets = new Map<string, TicketRecord>();

/** Control characters, never part of a path segment. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The path a ticket is bound to, normalized, or `null` when it is not plainly
 * a path inside the app. The same rule as the window's `extensionRequestPath`,
 * stricter in two places: no query, and no empty segment at all.
 *
 * @param path - The path below the app, e.g. `/videos/intro.mp4`.
 * @returns `/<segment>/<segment>`, each segment percent-encoded once.
 */
export function normalizeMediaPath(path: string): string | null {
  if (path.length > 4000 || !path.startsWith('/') || /[%\\?#]/.test(path)) return null;
  if (CONTROL.test(path)) return null;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return '/' + segments.map(encodeURIComponent).join('/');
}

/**
 * Mint a ticket for one path of one extension.
 *
 * @param extensionId - The extension.
 * @param subPath - A path {@link normalizeMediaPath} already normalized.
 * @param instance - The running instance it plays from (see {@link MediaTicketTarget}).
 * @param now - The current time, for tests.
 * @returns The ticket, 43 base64url characters.
 */
export function mintMediaTicket(
  extensionId: string,
  subPath: string,
  instance: object,
  now = Date.now()
): string {
  const own = [...tickets].filter(([, record]) => record.extensionId === extensionId);
  for (const [ticket] of own.slice(0, Math.max(0, own.length - MAX_MEDIA_TICKETS_PER_APP + 1))) {
    tickets.delete(ticket);
  }
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { extensionId, subPath, instance, mintedAt: now, usedAt: now });
  return ticket;
}

/**
 * What a ticket is bound to, or `null` when it is unknown or expired. The
 * lookup is the map's own, by the whole ticket, never a prefix. A good
 * ticket's idle time starts again.
 *
 * @param ticket - The ticket from the URL.
 * @param now - The current time, for tests.
 */
export function resolveMediaTicket(ticket: string, now = Date.now()): MediaTicketTarget | null {
  const record = tickets.get(ticket);
  if (!record) return null;
  if (
    now - record.usedAt >= MEDIA_TICKET_IDLE_MS ||
    now - record.mintedAt >= MEDIA_TICKET_MAX_AGE_MS
  ) {
    tickets.delete(ticket);
    return null;
  }
  record.usedAt = now;
  return { extensionId: record.extensionId, subPath: record.subPath, instance: record.instance };
}

/**
 * Forget every ticket of one extension: it stopped, reloaded or updated.
 *
 * @param extensionId - The extension.
 */
export function revokeMediaTickets(extensionId: string): void {
  for (const [ticket, record] of tickets) {
    if (record.extensionId === extensionId) tickets.delete(ticket);
  }
}

/** Forget every ticket. For tests. */
export function resetMediaTickets(): void {
  tickets.clear();
}

/** A media URL in any spelling a log line could carry it in. */
const MEDIA_PATH = /(\/extensions\/+media\/+)[^/?#]+/gi;

/**
 * A request path fit for a log line or an error report: a media URL's ticket
 * is written as `[ticket]`, since the ticket is the capability. Every other
 * path is returned as it is.
 *
 * @param path - The request path.
 */
export function redactMediaTicket(path: string): string {
  return path.replace(MEDIA_PATH, '$1[ticket]');
}
