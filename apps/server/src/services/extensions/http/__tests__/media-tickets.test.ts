/**
 * Video links for an app's frame (DOR-4321, Security 2026-11-18): a ticket
 * names one path of one app, is looked up whole, expires on idle and at a
 * hard cap, is bounded per app, and dies with the app's instance.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_MEDIA_TICKETS_PER_APP,
  MEDIA_TICKET_IDLE_MS,
  MEDIA_TICKET_MAX_AGE_MS,
  mintMediaTicket,
  normalizeMediaPath,
  redactMediaTicket,
  resetMediaTickets,
  resolveMediaTicket,
  revokeMediaTickets,
} from '../media-tickets.js';

const T0 = 1_000_000;
/** The running instance a ticket is minted for; only its identity matters. */
const APP = {};

beforeEach(() => resetMediaTickets());

describe('a media ticket', () => {
  it('is 256 random bits, base64url, and names exactly what it was minted for', () => {
    const ticket = mintMediaTicket('clips', '/videos/intro.mp4', APP, T0);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintMediaTicket('clips', '/videos/intro.mp4', APP, T0)).not.toBe(ticket);
    const target = resolveMediaTicket(ticket, T0);
    expect(target).toMatchObject({ extensionId: 'clips', subPath: '/videos/intro.mp4' });
    expect(target?.instance).toBe(APP);
  });

  it('is matched whole: a prefix, a longer string or another case finds nothing', () => {
    const ticket = mintMediaTicket('clips', '/a.mp4', APP, T0);
    expect(resolveMediaTicket(ticket.slice(0, 42), T0)).toBeNull();
    expect(resolveMediaTicket(`${ticket}x`, T0)).toBeNull();
    expect(resolveMediaTicket(`${ticket}/`, T0)).toBeNull();
    const flipped = ticket.replace(/[a-z]/, (ch) => ch.toUpperCase());
    if (flipped !== ticket) expect(resolveMediaTicket(flipped, T0)).toBeNull();
    expect(resolveMediaTicket(ticket, T0)).not.toBeNull();
  });

  it('expires 10 minutes after its last use, and each use starts that again', () => {
    const ticket = mintMediaTicket('clips', '/a.mp4', APP, T0);
    const nearlyIdle = T0 + MEDIA_TICKET_IDLE_MS - 1;
    expect(resolveMediaTicket(ticket, nearlyIdle)).not.toBeNull();
    // Used just now, so it lasts another 10 minutes from here.
    expect(resolveMediaTicket(ticket, nearlyIdle + MEDIA_TICKET_IDLE_MS - 1)).not.toBeNull();
    const later = nearlyIdle + MEDIA_TICKET_IDLE_MS - 1 + MEDIA_TICKET_IDLE_MS;
    expect(resolveMediaTicket(ticket, later)).toBeNull();
    // Gone for good, not just this once.
    expect(resolveMediaTicket(ticket, T0)).toBeNull();
  });

  it('ends 2 hours after it was minted, however often it is used', () => {
    const ticket = mintMediaTicket('clips', '/a.mp4', APP, T0);
    let now = T0;
    while (now + MEDIA_TICKET_IDLE_MS / 2 < T0 + MEDIA_TICKET_MAX_AGE_MS) {
      now += MEDIA_TICKET_IDLE_MS / 2;
      expect(resolveMediaTicket(ticket, now)).not.toBeNull();
    }
    expect(resolveMediaTicket(ticket, T0 + MEDIA_TICKET_MAX_AGE_MS)).toBeNull();
  });

  it('keeps at most 16 per app: the next one drops that app’s oldest, never another app’s', () => {
    const other = mintMediaTicket('notes', '/n.mp4', APP, T0);
    const mine = Array.from({ length: MAX_MEDIA_TICKETS_PER_APP }, (_, i) =>
      mintMediaTicket('clips', `/v${i}.mp4`, APP, T0 + i)
    );
    expect(mine.every((ticket) => resolveMediaTicket(ticket, T0 + 100) !== null)).toBe(true);
    const newest = mintMediaTicket('clips', '/v16.mp4', APP, T0 + 200);
    expect(resolveMediaTicket(mine[0]!, T0 + 200)).toBeNull();
    expect(mine.slice(1).every((ticket) => resolveMediaTicket(ticket, T0 + 200) !== null)).toBe(
      true
    );
    expect(resolveMediaTicket(newest, T0 + 200)).not.toBeNull();
    expect(resolveMediaTicket(other, T0 + 200)).not.toBeNull();
  });

  it('is revoked with every other ticket of its app, and only its app', () => {
    const a = mintMediaTicket('clips', '/a.mp4', APP, T0);
    const b = mintMediaTicket('clips', '/b.mp4', APP, T0);
    const other = mintMediaTicket('notes', '/n.mp4', APP, T0);
    revokeMediaTickets('clips');
    expect(resolveMediaTicket(a, T0)).toBeNull();
    expect(resolveMediaTicket(b, T0)).toBeNull();
    expect(resolveMediaTicket(other, T0)).not.toBeNull();
  });
});

describe('the path a ticket is bound to', () => {
  it('is normalized once, each part encoded', () => {
    expect(normalizeMediaPath('/videos/intro.mp4')).toBe('/videos/intro.mp4');
    expect(normalizeMediaPath('/q3 review/a:b.webm')).toBe('/q3%20review/a%3Ab.webm');
  });

  it.each([
    'videos/a.mp4',
    '/',
    '/a//b.mp4',
    '/a/',
    '/./a.mp4',
    '/../other/a.mp4',
    '/a/../../b.mp4',
    '/a%2Fb.mp4',
    '/a%2e%2e/b.mp4',
    '/a\\b.mp4',
    '/a.mp4?x=1',
    '/a.mp4#t=10',
    '/a\u0000.mp4',
    '/a\n.mp4',
    `/${'a'.repeat(4001)}`,
  ])('refuses %j', (path) => {
    expect(normalizeMediaPath(path)).toBeNull();
  });
});

describe('a media URL in a log line', () => {
  it('names the route, never the ticket', () => {
    const ticket = mintMediaTicket('clips', '/a.mp4', APP, T0);
    for (const path of [
      `/api/extensions/media/${ticket}`,
      `/API/Extensions/Media/${ticket}`,
      `//api/extensions//media/${ticket}`,
      `/api/extensions/media/${ticket}?x=1`,
    ]) {
      const logged = redactMediaTicket(path);
      expect(logged).not.toContain(ticket);
      expect(logged).toContain('[ticket]');
    }
  });

  it('leaves every other path as it is', () => {
    expect(redactMediaTicket('/api/extensions/clips/media-tickets')).toBe(
      '/api/extensions/clips/media-tickets'
    );
    expect(redactMediaTicket('/api/sessions/s1/messages')).toBe('/api/sessions/s1/messages');
  });
});
