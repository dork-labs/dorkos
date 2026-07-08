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
 * @module relay/endpoint-registry
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSubject } from './subject-matcher.js';
import type { EndpointInfo } from './types.js';

/** Maildir subdirectories created for each endpoint. */
const MAILDIR_DIRS = ['tmp', 'new', 'cur', 'failed'] as const;

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
   * @param subject - The hierarchical subject for this endpoint (e.g. `relay.agent.myproject.backend`).
   *                  Must not contain wildcards (`*` or `>`).
   * @returns The registered {@link EndpointInfo}
   * @throws If the subject is invalid or the endpoint is already registered
   */
  async registerEndpoint(subject: string): Promise<EndpointInfo> {
    const validation = validateSubject(subject);
    if (!validation.valid) {
      throw new Error(`Invalid subject: ${validation.reason.message}`);
    }

    // Endpoints must be concrete subjects — no wildcards
    if (subject.includes('*') || subject.includes('>')) {
      throw new Error('Endpoint subjects must not contain wildcards (* or >)');
    }

    if (this.endpoints.has(subject)) {
      throw new Error(`Endpoint already registered: ${subject}`);
    }

    const maildirPath = join(this.mailboxesDir, subject);

    // Create all Maildir subdirectories
    for (const dir of MAILDIR_DIRS) {
      await mkdir(join(maildirPath, dir), { recursive: true });
    }

    const info: EndpointInfo = {
      subject,
      hash: subject,
      maildirPath,
      registeredAt: new Date().toISOString(),
    };

    this.endpoints.set(subject, info);
    this.lastActivity.set(subject, Date.parse(info.registeredAt));
    return info;
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
