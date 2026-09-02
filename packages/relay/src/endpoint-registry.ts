/**
 * Endpoint registry for the Relay message bus.
 *
 * Manages the lifecycle of message endpoints — registering, unregistering,
 * and looking up endpoints by subject. Each registered endpoint gets a
 * Maildir directory structure (tmp/, new/, cur/, failed/) created under
 * the configured data directory.
 *
 * Directory names use the subject string directly (e.g. `relay.agent.myproject.backend/`).
 * Subject validation ensures all characters are POSIX-safe (`[a-zA-Z0-9_-]` tokens separated by dots).
 *
 * Two invariants here exist so that callers can gate access on ownership:
 *
 * - **One mailbox, one subject.** Subject validation permits `A-Z`, but APFS
 *   and NTFS are case-insensitive, so `relay.inbox.alice` and
 *   `relay.inbox.ALICE` would name the same directory on macOS and Windows.
 *   Registration rejects a subject that differs from an existing one only by
 *   letter case, on every platform, so the subject-to-mailbox map is injective
 *   and behaves the same everywhere.
 * - **Ownership outlives the process.** The endpoint map is in memory, but the
 *   Maildir and the SQLite index are not, so a registry that forgot who owned
 *   what would let the first caller after a restart claim someone else's
 *   mailbox. The owner is recorded in an `.owner` file beside the mailbox, and
 *   a registration whose owner disagrees with the recorded one is refused. The
 *   claim uses an exclusive create so two callers racing one unowned mailbox
 *   cannot both believe they won it.
 *
 * **Known gap: mailboxes that predate the `.owner` file.** Ownership is only as
 * durable as the recorded owner, and a mailbox created before this file existed
 * has none, so the first registration after the upgrade claims it. Reaching that
 * needs a pre-upgrade mailbox, a restart onto a build that has this code, and
 * winning the race against the real owner's next poll. It is deliberately NOT
 * closed by refusing to claim unowned mailboxes: `relay.system.console` and
 * every endpoint created from the cockpit are unowned by design and must stay
 * registrable, and an agent's own pre-existing inbox would otherwise be denied
 * to it forever. A permanent regression on correct paths is the worse trade than
 * a one-time race on an upgrade boundary.
 *
 * @module relay/endpoint-registry
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSubject } from './subject-matcher.js';
import { isControlSubject } from './lib/reserved-subjects.js';
import type { EndpointInfo } from './types.js';

/** Maildir subdirectories created for each endpoint. */
const MAILDIR_DIRS = ['tmp', 'new', 'cur', 'failed'] as const;

/**
 * Filename holding the endpoint's owner, written beside the Maildir
 * subdirectories rather than inside one so the message scanners
 * (`listCurrent`, `getNewestActivityMs`, the GC sweeps) never see it.
 */
const OWNER_FILENAME = '.owner';

/**
 * Whether a filesystem error is `EEXIST` (the exclusive-create owner claim lost
 * a race to another caller).
 *
 * @param err - The thrown error
 */
function isEexist(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Read the owner recorded beside a mailbox.
 *
 * A missing, empty, or unreadable file means no owner is recorded. That is
 * deliberately reported as "nobody owns this" so an unreadable file can only
 * narrow access, never widen it.
 *
 * Surrounding whitespace is trimmed to tolerate a hand-edited file. That is not
 * the kind of normalization that hides a collision: a valid subject can never
 * contain whitespace, so trimming cannot map two different subjects onto one.
 *
 * @param maildirPath - Absolute path to the endpoint's Maildir
 * @returns The recorded owner subject, or `undefined` when there is none
 */
async function readOwner(maildirPath: string): Promise<string | undefined> {
  try {
    const raw = (await readFile(join(maildirPath, OWNER_FILENAME), 'utf-8')).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * In-memory registry of message endpoints, backed by Maildir directories on disk.
 *
 * Endpoints are stored in a `Map<subject, EndpointInfo>` for O(1) lookup.
 * On registration, the Maildir directory structure is created atomically.
 * On unregistration, directories are removed and the entry is deleted.
 */
export class EndpointRegistry {
  /** Base directory for all endpoint mailboxes (e.g. `~/.dork/relay/mailboxes`). */
  private readonly mailboxesDir: string;

  /** Subject -> EndpointInfo mapping. */
  private readonly endpoints = new Map<string, EndpointInfo>();

  /**
   * Subject -> last-activity timestamp (ms since epoch).
   *
   * Refreshed on reads/deliveries via {@link touch} so the dispatch-inbox TTL
   * sweeper can expire endpoints on INACTIVITY rather than age-since-
   * registration — an actively-polled inbox must not be swept mid-conversation.
   */
  private readonly lastActivity = new Map<string, number>();

  /**
   * Create an EndpointRegistry.
   *
   * @param dataDir - Root data directory for Relay (e.g. `~/.dork/relay`).
   *                  Mailboxes will be created under `{dataDir}/mailboxes/`.
   */
  constructor(dataDir: string) {
    this.mailboxesDir = join(dataDir, 'mailboxes');
  }

  /**
   * Register a new message endpoint.
   *
   * Validates the subject, creates the Maildir directory structure using
   * the subject string as the directory name, and stores the endpoint info in memory.
   *
   * Refuses the registration when the subject would share a mailbox with an
   * existing endpoint (a letter-case variant) or when the mailbox already
   * records a different owner. Both are ownership boundaries, not conveniences:
   * see the module docs. Also refuses any control subject outright — see
   * {@link isControlSubject}.
   *
   * @param subject - The hierarchical subject for this endpoint (e.g. `relay.agent.myproject.backend`).
   *                  Must not contain wildcards (`*` or `>`).
   * @param options - Registration options. `owner` records the Relay subject of
   *                  the principal registering the endpoint, so later callers
   *                  can tell whose mailbox this is (see {@link EndpointInfo.owner}).
   * @returns The registered {@link EndpointInfo}
   * @throws If the subject is invalid, names a control channel, is already
   *   registered, collides with an existing mailbox, or belongs to a different
   *   owner
   */
  async registerEndpoint(subject: string, options?: { owner?: string }): Promise<EndpointInfo> {
    const validation = validateSubject(subject);
    if (!validation.valid) {
      throw new Error(`Invalid subject: ${validation.reason.message}`);
    }

    // Endpoints must be concrete subjects — no wildcards
    if (subject.includes('*') || subject.includes('>')) {
      throw new Error('Endpoint subjects must not contain wildcards (* or >)');
    }

    // Control signals travel by subscription and are never held in a mailbox.
    // Refused here rather than at each caller, and with no opt-out: an endpoint
    // here inflates `deliveredTo` into a false confirmation for every control
    // signal on that subject (see `isControlSubject`), and no caller — the
    // server included — has a reason to want one.
    if (isControlSubject(subject)) {
      throw new Error(
        `Subject "${subject}" is a control channel and cannot have a mailbox: ` +
          'control signals are delivered to subscribers, never stored'
      );
    }

    if (this.endpoints.has(subject)) {
      throw new Error(`Endpoint already registered: ${subject}`);
    }

    const variant = await this.findCaseVariant(subject);
    if (variant !== undefined) {
      throw new Error(
        `Subject collides with existing endpoint "${variant}": subjects that differ only by ` +
          'letter case share one mailbox on macOS and Windows'
      );
    }

    const maildirPath = join(this.mailboxesDir, subject);

    // Read the recorded owner BEFORE creating anything: a mailbox left on disk
    // by a previous process still belongs to whoever registered it, so the
    // first caller after a restart must not be able to claim it.
    const recordedOwner = await readOwner(maildirPath);
    if (
      recordedOwner !== undefined &&
      options?.owner !== undefined &&
      recordedOwner !== options.owner
    ) {
      throw new Error(`Endpoint belongs to another owner: ${subject}`);
    }
    // A registration that names no owner (the server registering on its own
    // behalf) must never erase a recorded one.
    const owner = recordedOwner ?? options?.owner;

    // Create all Maildir subdirectories
    for (const dir of MAILDIR_DIRS) {
      await mkdir(join(maildirPath, dir), { recursive: true });
    }

    // Claim an unclaimed mailbox atomically. The read above and this write are
    // separate syscalls, so without an exclusive create two callers racing the
    // same unowned mailbox would BOTH see no owner and both believe they claimed
    // it, with the later write silently deciding. That window needs no restart to
    // reach: `registerEndpoint` awaits between the in-memory check and
    // `endpoints.set`, so two concurrent calls in ONE process reach it, as do two
    // processes sharing a dataDir (the desktop app and the CLI cockpit both
    // default to ~/.dork). `wx` fails when the file exists, so exactly one caller
    // claims and every other one is told whose it is.
    const claimed = owner !== undefined && recordedOwner === undefined;
    let lostRace = false;
    if (claimed) {
      try {
        await writeFile(join(maildirPath, OWNER_FILENAME), owner, {
          encoding: 'utf-8',
          flag: 'wx',
        });
      } catch (err) {
        if (!isEexist(err)) throw err;
        // Lost the race, which is the protocol working rather than a failure —
        // so the EEXIST is fully HANDLED here and goes no further. It is
        // deliberately not chained onto the throw below: that error reports a
        // fact read from disk ("someone else owns this"), and the errno is only
        // how we found out to go and look. Attaching it would dress a normal
        // race up as the underlying fault and tell a reader nothing they could
        // act on — the owner's name is the actionable part, and it is already in
        // the message.
        lostRace = true;
      }
    }
    if (lostRace) {
      // The winner's claim stands; re-read and defer to it.
      const winner = await readOwner(maildirPath);
      if (winner !== owner) {
        throw new Error(`Endpoint belongs to another owner: ${subject}`);
      }
    }

    const info: EndpointInfo = {
      subject,
      hash: subject,
      maildirPath,
      registeredAt: new Date().toISOString(),
      ...(owner !== undefined ? { owner } : {}),
    };

    this.endpoints.set(subject, info);
    this.lastActivity.set(subject, Date.parse(info.registeredAt));
    return info;
  }

  /**
   * Find a registered endpoint or existing mailbox that differs from `subject`
   * only by letter case.
   *
   * Checks the in-memory map and the mailboxes directory, because a mailbox
   * outlives the process that registered it. On a case-insensitive filesystem
   * the on-disk scan is what catches the collision; it runs on case-sensitive
   * filesystems too so behaviour does not vary by platform.
   *
   * @param subject - The subject about to be registered
   * @returns The colliding subject, or `undefined` when there is none
   */
  private async findCaseVariant(subject: string): Promise<string | undefined> {
    const folded = subject.toLowerCase();

    for (const existing of this.endpoints.keys()) {
      if (existing !== subject && existing.toLowerCase() === folded) return existing;
    }

    let entries: string[];
    try {
      entries = await readdir(this.mailboxesDir);
    } catch {
      // No mailboxes directory yet, so nothing to collide with.
      return undefined;
    }
    return entries.find((entry) => entry !== subject && entry.toLowerCase() === folded);
  }

  /**
   * Record activity on an endpoint (a read, claim, or delivery).
   *
   * No-op for unregistered subjects. Resets the inactivity clock the TTL
   * sweeper reads via {@link getLastActivityMs}.
   *
   * @param subject - The endpoint subject that saw activity.
   */
  touch(subject: string): void {
    if (this.endpoints.has(subject)) {
      this.lastActivity.set(subject, Date.now());
    }
  }

  /**
   * Last-activity timestamp (ms) for an endpoint, falling back to its
   * registration time when no activity has been recorded yet.
   *
   * @param subject - The endpoint subject to look up.
   * @returns Last-activity ms, or `undefined` if the endpoint is unregistered.
   */
  getLastActivityMs(subject: string): number | undefined {
    const info = this.endpoints.get(subject);
    if (!info) return undefined;
    return this.lastActivity.get(subject) ?? Date.parse(info.registeredAt);
  }

  /**
   * Unregister an endpoint and remove its Maildir directory.
   *
   * @param subject - The subject of the endpoint to unregister
   * @returns `true` if the endpoint was found and removed, `false` if not found
   */
  async unregisterEndpoint(subject: string): Promise<boolean> {
    const info = this.endpoints.get(subject);
    if (!info) {
      return false;
    }

    // Remove the Maildir directory tree
    await rm(info.maildirPath, { recursive: true, force: true });

    this.endpoints.delete(subject);
    this.lastActivity.delete(subject);
    return true;
  }

  /**
   * Look up an endpoint by its subject.
   *
   * @param subject - The subject to look up
   * @returns The {@link EndpointInfo} if found, or `undefined`
   */
  getEndpoint(subject: string): EndpointInfo | undefined {
    return this.endpoints.get(subject);
  }

  /**
   * Look up an endpoint by its hash.
   *
   * Performs a linear scan since hash-based lookup is secondary.
   * Use {@link getEndpoint} for the common case of subject-based lookup.
   *
   * @param hash - The endpoint hash to look up
   * @returns The {@link EndpointInfo} if found, or `undefined`
   */
  getEndpointByHash(hash: string): EndpointInfo | undefined {
    for (const info of this.endpoints.values()) {
      if (info.hash === hash) {
        return info;
      }
    }
    return undefined;
  }

  /**
   * List all registered endpoints.
   *
   * @returns An array of all registered {@link EndpointInfo} objects
   */
  listEndpoints(): EndpointInfo[] {
    return Array.from(this.endpoints.values());
  }

  /**
   * Check whether an endpoint is registered for the given subject.
   *
   * @param subject - The subject to check
   * @returns `true` if an endpoint is registered for this subject
   */
  hasEndpoint(subject: string): boolean {
    return this.endpoints.has(subject);
  }

  /**
   * Get the number of registered endpoints.
   *
   * @returns The count of registered endpoints
   */
  get size(): number {
    return this.endpoints.size;
  }
}
