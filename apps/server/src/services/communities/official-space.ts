/**
 * Which space is the official DorkOS space, worked out on every read (spec
 * `official-community-space` D4, D5).
 *
 * The official space is the one exception to the spaces experiment (DOR-2740): its row shows,
 * it can be joined, and its agents can be woken while every other space stays switched off. The
 * answer is never stored. A connection keeps the origin and community id discovery returned when
 * it was paired, and "official" is decided each time by comparing those to the link configured
 * now (`spaces.official.url`, or `DORKOS_OFFICIAL_SPACE_URL`). Changing or clearing the link
 * un-officials an old connection at once.
 *
 * A canonical `/c/<uuid>` link names the community outright. A short-name or origin-only link
 * does not, so the community it led to is recorded when a pairing starts from it
 * (`official-space.json`): the link, the origin and the community id discovery returned. That
 * record answers only while it was made for the link configured now.
 *
 * Nothing here compares against a literal hostname.
 *
 * @module services/communities/official-space
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../lib/logger.js';
import { parseCommunityLink, type ParsedCommunityLink } from './remote/pinned-origin.js';

/** What a connection says about where it points: enough to decide "official". */
export interface ConnectionPlace {
  /** The origin the connection is pinned to. */
  pinnedOrigin: string;
  /** The community id discovery returned when it was paired. */
  remoteCommunityId: string;
}

/** One committed connection change, as {@link OfficialSpace.follow} applies it. */
export interface ConnectionPlaceChange extends ConnectionPlace {
  /** The local connection ref. */
  ref: CommunityRef;
  /** Where the connection is now; `removed` means it is gone. */
  status: string;
}

const ResolutionSchema = z.strictObject({
  /** The configured link, in {@link linkKey} form, this record was made for. */
  link: z.string().min(1),
  origin: z.string().min(1),
  communityId: z.string().min(1),
});
type Resolution = z.infer<typeof ResolutionSchema>;

/**
 * One link in a form two spellings of the same address compare equal in: the origin plus the
 * canonical id, the lower-cased short name, or nothing.
 */
function linkKey(link: ParsedCommunityLink): string {
  if (link.communityId) return `${link.origin.origin}/c/${link.communityId}`;
  if (link.shortName) return `${link.origin.origin}/${link.shortName}`;
  return link.origin.origin;
}

/** Parse a configured or typed link, or `null` for an empty or unusable one. */
function parseLink(url: string): ParsedCommunityLink | null {
  if (!url.trim()) return null;
  try {
    return parseCommunityLink(url.trim());
  } catch {
    return null;
  }
}

/**
 * The configured official link when it is a usable space address, trimmed, or `null` when it is
 * empty or unusable: what the app is told, so it offers the official space only when it can be
 * joined.
 *
 * @param raw - The link as configured.
 */
export function usableOfficialLink(raw: string): string | null {
  return parseLink(raw) ? raw.trim() : null;
}

/**
 * The official-space answer for this install: which link is official, which connections it
 * covers, and whether a space may be reached right now.
 */
export class OfficialSpace {
  private readonly file: string;
  private resolution: Resolution | null | undefined;
  private readonly places = new Map<CommunityRef, ConnectionPlace>();
  private loaded = false;
  /** Changes committed while {@link load} was reading, replayed over what it read. */
  private duringLoad: ConnectionPlaceChange[] | null = null;
  private warnedLink: string | null = null;

  /**
   * Read the official link and the experiment through the given readers, and keep the matched
   * short-name record beside the connection store.
   *
   * @param dorkHome - The resolved local DorkOS data directory.
   * @param readUrl - The configured official link, read on every call; `''` means none.
   * @param spacesOn - Whether the spaces experiment is on, read on every call.
   */
  constructor(
    dorkHome: string,
    private readonly readUrl: () => string,
    private readonly spacesOn: () => boolean
  ) {
    this.file = path.join(dorkHome, 'communities', 'remote', 'official-space.json');
  }

  /** The configured official link, parsed, or `null` when there is none or it is unusable. */
  link(): ParsedCommunityLink | null {
    const raw = this.readUrl();
    const parsed = parseLink(raw);
    if (!parsed && raw.trim() && this.warnedLink !== raw) {
      this.warnedLink = raw;
      logger.warn('[OfficialSpace] The official space link is not a usable space address');
    }
    return parsed;
  }

  /** The configured official link as text, or `null` when the exception is off. */
  url(): string | null {
    return this.link() ? usableOfficialLink(this.readUrl()) : null;
  }

  /** The origin of the configured official link, or `null`. */
  origin(): string | null {
    return this.link()?.origin.origin ?? null;
  }

  /**
   * Whether a link a person typed is the configured official link, in any spelling that names
   * the same address.
   *
   * @param url - The link to compare.
   */
  isOfficialLink(url: string): boolean {
    const official = this.link();
    const typed = parseLink(url);
    return official !== null && typed !== null && linkKey(official) === linkKey(typed);
  }

  /**
   * Whether a connection points at the official space, judged against the link configured now.
   *
   * @param place - The connection's pinned origin and community id.
   */
  isOfficialConnection(place: ConnectionPlace): boolean {
    const official = this.link();
    if (!official || official.origin.origin !== place.pinnedOrigin) return false;
    if (official.communityId) return official.communityId === place.remoteCommunityId;
    const resolution = this.readResolution();
    return (
      resolution !== null &&
      resolution.link === linkKey(official) &&
      resolution.origin === place.pinnedOrigin &&
      resolution.communityId === place.remoteCommunityId
    );
  }

  /**
   * Whether the connection behind a ref is official. Answered from memory, so the live stream,
   * the outbox and room reads can ask synchronously; `false` until {@link load} has run.
   *
   * @param ref - The local connection ref.
   */
  isOfficialRef(ref: CommunityRef): boolean {
    const place = this.places.get(ref);
    return place !== undefined && this.isOfficialConnection(place);
  }

  /**
   * `spaceReachable(ref)`: the spaces experiment is on, or this connection is the official one.
   * Every space surface asks this rather than the experiment alone (spec D5).
   *
   * @param ref - The local connection ref.
   */
  reachable(ref: CommunityRef): boolean {
    return this.spacesOn() || this.isOfficialRef(ref);
  }

  /**
   * Record what a pairing that started from the official link discovered, so a short-name or
   * origin-only link can be matched to its community later. A pairing from any other link
   * records nothing. Written before the pending connection is, so its own change is judged with
   * it.
   *
   * @param url - The link the pairing started from.
   * @param origin - The origin discovery answered on.
   * @param communityId - The community id discovery returned.
   */
  async noteDiscovery(url: string, origin: string, communityId: string): Promise<void> {
    const official = this.link();
    if (!official || !this.isOfficialLink(url) || official.communityId) return;
    const next: Resolution = { link: linkKey(official), origin, communityId };
    const current = this.readResolution();
    if (
      current &&
      current.link === next.link &&
      current.origin === next.origin &&
      current.communityId === next.communityId
    )
      return;
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.official-space-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
    this.resolution = next;
  }

  /**
   * Learn every connection's place, before anything remote starts. Until it has run no ref is
   * official, so a space stays unreachable with the experiment off: fail closed.
   *
   * @param read - Every owner's connection with its place.
   */
  async load(read: () => Promise<readonly (ConnectionPlace & { ref: CommunityRef })[]>) {
    this.duringLoad = [];
    try {
      const connections = await read();
      this.places.clear();
      for (const connection of connections)
        this.places.set(connection.ref, {
          pinnedOrigin: connection.pinnedOrigin,
          remoteCommunityId: connection.remoteCommunityId,
        });
      this.apply(this.duringLoad);
      this.loaded = true;
    } finally {
      this.duringLoad = null;
    }
  }

  /** Whether {@link load} has run. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Keep the in-memory places in step with one committed write. Applied synchronously, from the
   * change itself, so no read can race it.
   *
   * @param changes - The connections that write changed.
   */
  follow(changes: readonly ConnectionPlaceChange[]): void {
    this.duringLoad?.push(...changes);
    this.apply(changes);
  }

  private apply(changes: readonly ConnectionPlaceChange[]): void {
    for (const change of changes) {
      if (change.status === 'removed') this.places.delete(change.ref);
      else
        this.places.set(change.ref, {
          pinnedOrigin: change.pinnedOrigin,
          remoteCommunityId: change.remoteCommunityId,
        });
    }
  }

  private readResolution(): Resolution | null {
    if (this.resolution !== undefined) return this.resolution;
    try {
      this.resolution = ResolutionSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // Missing or unreadable: no short-name link has been matched yet.
      this.resolution = null;
    }
    return this.resolution;
  }
}
