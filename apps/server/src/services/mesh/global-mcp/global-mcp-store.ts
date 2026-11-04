/**
 * The MCP servers a person adds once for every agent (DOR-3213), kept in
 * `{dorkHome}/mcp/global-servers.json`.
 *
 * ## Who writes it
 *
 * A person, in Connections → MCP servers, and nobody else. There is no
 * capability, MCP tool or agent route that reaches this store: an agent's own
 * `mcp_add_server` writes its own manifest, never this file. The routes in
 * `routes/mcp-servers.ts` are the only writers, and they refuse an agent.
 *
 * ## Secrets
 *
 * Any env or header value whose name is secret (`isSecretName`: TOKEN, KEY,
 * SECRET, PASS, PWD, BEARER, AUTH, COOKIE and the like, or a name the person marked) is moved into the
 * encrypted {@link CredentialStore} and replaced in the file by a `file:`
 * reference, the same scheme relay adapters use (`relay/adapter-secrets.ts`).
 * The real value is held in memory only, for injection, and is never logged,
 * written back or returned: {@link GlobalMcpStore.list} gives a secret's name
 * and nothing else.
 *
 * ## Why it holds a resolved copy
 *
 * Runtimes ask for their servers synchronously (`injectableServersForCwd`), and
 * the credential store is async. So the store resolves every reference once at
 * {@link GlobalMcpStore.load} and again after each write, and answers
 * {@link GlobalMcpStore.injectableFor} from memory. A change is visible to the
 * next turn of every running agent, with no restart.
 *
 * ## What it may run
 *
 * {@link refuseGlobalServer} decides, when a person saves a server and again
 * before each injection. The second check is for the file itself: any program
 * running as this user can write it, so a server that never came through the
 * routes is dropped, logged and shown as stopped. That stops accidents and hand
 * edits with bad paths. It is not a boundary: an agent at Full can still place a
 * script somewhere the check allows (DOR-505).
 *
 * @module services/mesh/global-mcp/global-mcp-store
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  GlobalMcpServerNameSchema,
  isSecretName,
  type GlobalMcpServerInput,
  type GlobalMcpServerPatch,
  type GlobalMcpServerView,
} from '@dorkos/shared/global-mcp-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { McpServerTransportSchema, type McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { CredentialStore } from '../../core/credential-provider.js';
import { RESERVED_MCP_SERVER_NAME } from '../agent-mcp-server-service.js';
import {
  flaggedEnvNames,
  refuseGlobalServer,
  type GlobalMcpGuardContext,
  type GlobalMcpRefusal,
} from './global-mcp-guard.js';
import { holdsMask, maskedArgs, maskUrls } from './global-mcp-mask.js';

/** The file's mode: the person's own, like every other DorkOS secret file. */
const FILE_MODE = 0o600;

/** Prefix of every credential-store key this module writes. */
const SECRET_KEY_PREFIX = 'global-mcp';

/** One server as the file stores it: secret values are `file:` references. */
const StoredServerSchema = z.object({
  name: GlobalMcpServerNameSchema,
  enabled: z.boolean(),
  connection: McpServerTransportSchema,
  secretNames: z.array(z.string()),
  excludedAgents: z.array(z.string()),
  addedAt: z.string(),
});

type StoredServer = z.infer<typeof StoredServerSchema>;

const StoredFileSchema = z.object({
  version: z.literal(1),
  servers: z.array(StoredServerSchema),
});

/** Why a write was refused, in words a person can act on. */
export class GlobalMcpStoreError extends Error {
  constructor(
    readonly code:
      | 'name_taken'
      | 'reserved_name'
      | 'not_found'
      | 'oauth_unsupported'
      | 'unreadable'
      | 'changed'
      | 'secret_left'
      | 'masked_value'
      | GlobalMcpRefusal['code'],
    message: string
  ) {
    super(message);
    this.name = 'GlobalMcpStoreError';
  }
}

/** A switch that would let more agents run a server, asked for without confirming it. */
export class GlobalMcpWidensError extends Error {
  constructor() {
    super('That lets more agents run this server.');
    this.name = 'GlobalMcpWidensError';
  }
}

/** What a server does, secret values as `file:` references. Server-side only. */
export type GlobalMcpServerShape = Pick<
  StoredServer,
  'name' | 'enabled' | 'connection' | 'secretNames' | 'excludedAgents'
>;

/** How a {@link GlobalMcpStore.patch} must be checked inside the write queue. */
export interface GlobalMcpPatchGuard {
  /** Refuse with {@link GlobalMcpWidensError} if it would let more agents run the server. */
  narrowOnly?: boolean;
  /** Refuse unless the server still matches this {@link GlobalMcpStore.fingerprint}. */
  expect?: string;
}

/** Whether a change makes a server run for any agent it did not run for before. */
function widens(before: StoredServer, after: StoredServer): boolean {
  if (!after.enabled) return false;
  if (!before.enabled) return true;
  return before.excludedAgents.some((agent) => !after.excludedAgents.includes(agent));
}

/** The hash of what a server does. Its stored references stay inside this process. */
function fingerprintOf(server: StoredServer): string {
  const { name, enabled, connection, secretNames, excludedAgents } = server;
  return createHash('sha256')
    .update(stableStringify({ name, enabled, connection, secretNames, excludedAgents }), 'utf8')
    .digest('hex');
}

/** The env map of a stdio server, or the header map of a remote one. */
function valuesOf(connection: McpServerTransport): Record<string, string> {
  return connection.transport === 'stdio' ? connection.env : connection.headers;
}

/** The same connection with its env or header map swapped. */
function withValues(
  connection: McpServerTransport,
  values: Record<string, string>
): McpServerTransport {
  return connection.transport === 'stdio'
    ? { ...connection, env: values }
    : { ...connection, headers: values };
}

/** The credential-store key for one secret value. */
function secretKey(server: string, name: string): string {
  return `${SECRET_KEY_PREFIX}-${server}-${Buffer.from(name).toString('hex')}`;
}

/** The runtime-neutral connection a runtime is handed. */
function toInjectable(connection: McpServerTransport): McpAppServerConnection {
  if (connection.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: connection.command,
      args: connection.args,
      env: connection.env,
    };
  }
  return { transport: connection.transport, url: connection.url, headers: connection.headers };
}

/** What {@link GlobalMcpStore} needs beyond its data directory and secrets. */
export interface GlobalMcpStoreOptions {
  /** Every registered agent's folder, read at each check. Omitted → none. */
  agentRoots?: () => readonly string[];
  /** Where a dropped server is reported. */
  logger?: Pick<Logger, 'warn'>;
}

/** Persists the person's global MCP servers and serves them to runtimes. */
export class GlobalMcpStore {
  private readonly file: string;
  private readonly dorkHome: string;
  private readonly agentRoots: () => readonly string[];
  private readonly logger: Pick<Logger, 'warn'>;
  /** Servers already reported as dropped, so each says so once. */
  private readonly reportedDropped = new Set<string>();
  private servers: StoredServer[] = [];
  /** Each server's connection with its secrets resolved. Memory only. */
  private resolved = new Map<string, McpServerTransport>();
  /** Writes run one at a time, so two can never interleave across an await. */
  private writes: Promise<unknown> = Promise.resolve();
  /**
   * Set when the file exists but could not be read: every write is refused, so
   * saving a new server can never overwrite the servers that file still holds.
   */
  private unreadable = false;

  /**
   * Build a store over the data directory. Call {@link GlobalMcpStore.load} before use.
   *
   * @param dorkHome - The resolved DorkOS data directory.
   * @param secrets - The encrypted store secret values live in.
   * @param options - Where agents write, and where to report a dropped server.
   */
  constructor(
    dorkHome: string,
    private readonly secrets: CredentialStore,
    options: GlobalMcpStoreOptions = {}
  ) {
    this.dorkHome = dorkHome;
    this.file = path.join(dorkHome, 'mcp', 'global-servers.json');
    this.agentRoots = options.agentRoots ?? (() => []);
    this.logger = options.logger ?? console;
  }

  /** Read the file and resolve every secret. A missing file is an empty list. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.servers = [];
        this.resolved = new Map();
        return;
      }
      throw err;
    }
    try {
      this.servers = StoredFileSchema.parse(JSON.parse(raw)).servers;
    } catch (err) {
      this.unreadable = true;
      throw err;
    }
    this.unreadable = false;
    await this.resolveAll();
  }

  /**
   * Whether a person saved a server by this name for every agent, on or off.
   *
   * @param name - The server name.
   */
  has(name: string): boolean {
    return this.servers.some((server) => server.name === name);
  }

  /** Every server, as a person sees it: secret values never included. */
  list(): GlobalMcpServerView[] {
    return this.servers.map((server) => this.view(server));
  }

  /**
   * The enabled servers an agent gets, by name, with secrets resolved.
   *
   * @param agentId - The agent the session acts as.
   */
  injectableFor(agentId: string): Record<string, McpAppServerConnection> {
    const out: Record<string, McpAppServerConnection> = {};
    const ctx = this.guardContext();
    for (const server of this.servers) {
      if (!server.enabled || server.excludedAgents.includes(agentId)) continue;
      const connection = this.resolved.get(server.name);
      if (!connection) continue;
      // Checked on every injection, not only at save: the file can be written
      // by hand, and an agent folder can appear under a saved path later.
      const refusal = refuseGlobalServer(connection, ctx);
      if (refusal) {
        this.reportDropped(server.name, refusal);
        continue;
      }
      out[server.name] = toInjectable(connection);
    }
    return out;
  }

  /**
   * Add a server for every agent.
   *
   * @param input - The server, with its secret values typed by a person.
   */
  add(input: GlobalMcpServerInput): Promise<GlobalMcpServerView> {
    return this.exclusive(async () => {
      this.refuseAdd(input);
      return this.put(input, new Date().toISOString());
    });
  }

  /**
   * Throw why this add would be refused, without writing anything, so a person
   * is not asked to confirm what cannot run.
   *
   * @param input - The server.
   */
  refuseAdd(input: GlobalMcpServerInput): void {
    this.refuseUnreadable();
    if (this.servers.some((s) => s.name === input.name)) {
      throw new GlobalMcpStoreError('name_taken', `There's already a server named ${input.name}.`);
    }
    this.refuseInput(input);
  }

  /**
   * Throw why this replace would be refused, without writing anything.
   *
   * @param name - The server to replace.
   * @param input - Its new definition.
   */
  refuseReplace(name: string, input: GlobalMcpServerInput): void {
    this.refuseUnreadable();
    this.find(name);
    if (input.name !== name) {
      throw new GlobalMcpStoreError('name_taken', 'Remove the server to give it a new name.');
    }
    this.refuseInput(input);
  }

  /**
   * What a server does now, for a step-up to name. Secrets stay references.
   *
   * @param name - The server.
   */
  shapeOf(name: string): GlobalMcpServerShape {
    const { enabled, connection, secretNames, excludedAgents } = this.find(name);
    return { name, enabled, connection, secretNames, excludedAgents };
  }

  /**
   * A hash of what a server does now, so a held change can tell it moved.
   *
   * @param name - The server.
   */
  fingerprint(name: string): string {
    return fingerprintOf(this.find(name));
  }

  /**
   * Replace a server, secrets and all: a changed secret is typed again.
   *
   * @param name - The server to replace.
   * @param input - Its new definition. The name may not change.
   */
  replace(name: string, input: GlobalMcpServerInput): Promise<GlobalMcpServerView> {
    return this.exclusive(async () => {
      // Every refusal before anything is deleted, so a refused edit leaves the
      // working server running with its secrets.
      this.refuseReplace(name, input);
      const existing = this.find(name);
      await this.deleteSecrets(existing);
      this.servers = this.servers.filter((s) => s.name !== name);
      return this.put(input, existing.addedAt);
    });
  }

  /**
   * Flip a server on or off, or change which agents it skips.
   *
   * @param name - The server.
   * @param patch - What to change.
   * @param guard - Checks that must hold in the write queue, not before it, so
   *   another write can't change the answer in between.
   * @throws GlobalMcpWidensError when `guard.narrowOnly` and it would widen.
   */
  patch(
    name: string,
    patch: GlobalMcpServerPatch,
    guard: GlobalMcpPatchGuard = {}
  ): Promise<GlobalMcpServerView> {
    return this.exclusive(async () => {
      const existing = this.find(name);
      if (guard.expect !== undefined && fingerprintOf(existing) !== guard.expect) {
        throw new GlobalMcpStoreError('changed', `${name} changed. Check it and try again.`);
      }
      const next: StoredServer = {
        ...existing,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.excludedAgents !== undefined ? { excludedAgents: patch.excludedAgents } : {}),
      };
      if (guard.narrowOnly && widens(existing, next)) throw new GlobalMcpWidensError();
      this.servers = this.servers.map((s) => (s.name === name ? next : s));
      await this.persist();
      return this.view(next);
    });
  }

  /**
   * Remove a server and its stored secrets. The file is written first, so no
   * agent can get the server again whatever happens next; a secret that then
   * fails to delete is said out loud, since retrying the remove finds no server.
   *
   * @param name - The server.
   * @throws GlobalMcpStoreError `secret_left` when the server is gone but a saved
   *   secret was not deleted. Adding the same server again overwrites it.
   */
  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const existing = this.find(name);
      this.servers = this.servers.filter((s) => s.name !== name);
      this.resolved.delete(name);
      await this.persist();
      try {
        await this.deleteSecrets(existing);
      } catch {
        throw new GlobalMcpStoreError(
          'secret_left',
          `${name} is removed, but its saved key couldn't be deleted.`
        );
      }
    });
  }

  /** Run one write after every write before it, refusing all of them on an unreadable file. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(() => {
      this.refuseUnreadable();
      return work();
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Throw when the file exists but could not be read. */
  private refuseUnreadable(): void {
    if (this.unreadable) {
      throw new GlobalMcpStoreError(
        'unreadable',
        'The saved MCP servers could not be read, so nothing was changed.'
      );
    }
  }

  /** Throw why a server may not be saved, if it may not. Changes nothing. */
  private refuseInput(input: GlobalMcpServerInput): void {
    if (input.name === RESERVED_MCP_SERVER_NAME) {
      throw new GlobalMcpStoreError('reserved_name', `${input.name} is DorkOS's own server.`);
    }
    if (input.connection.transport !== 'stdio' && input.connection.authKind === 'oauth2') {
      throw new GlobalMcpStoreError(
        'oauth_unsupported',
        'A server that signs in is added per agent for now.'
      );
    }
    const { connection } = input;
    const typed = [
      ...Object.values(valuesOf(connection)),
      ...(connection.transport === 'stdio' ? connection.args : [connection.url]),
    ];
    if (holdsMask(typed)) {
      throw new GlobalMcpStoreError(
        'masked_value',
        'A value here is still hidden. Type the real one.'
      );
    }
    const refusal = refuseGlobalServer(input.connection, this.guardContext());
    if (refusal) throw new GlobalMcpStoreError(refusal.code, refusal.message);
  }

  /** Store one server, moving its secret values into the credential store. */
  private async put(input: GlobalMcpServerInput, addedAt: string): Promise<GlobalMcpServerView> {
    this.refuseInput(input);
    const stored: Record<string, string> = {};
    for (const [key, value] of Object.entries(valuesOf(input.connection))) {
      stored[key] = isSecretName(key, input.secretNames)
        ? await this.secrets.put(secretKey(input.name, key), value)
        : value;
    }
    const server: StoredServer = {
      name: input.name,
      enabled: input.enabled,
      connection: withValues(input.connection, stored),
      secretNames: input.secretNames,
      excludedAgents: input.excludedAgents,
      addedAt,
    };
    this.servers = [...this.servers, server];
    this.resolved.set(server.name, input.connection);
    await this.persist();
    return this.view(server);
  }

  private find(name: string): StoredServer {
    const server = this.servers.find((s) => s.name === name);
    if (!server) throw new GlobalMcpStoreError('not_found', `No server named ${name}.`);
    return server;
  }

  /** The person's view: a secret shows its name, never its value. */
  private view(server: StoredServer): GlobalMcpServerView {
    const fields = Object.keys(valuesOf(server.connection)).map((name) => ({
      name,
      secret: isSecretName(name, server.secretNames),
    }));
    const { connection } = server;
    return {
      name: server.name,
      enabled: server.enabled,
      transport: connection.transport,
      ...(connection.transport === 'stdio'
        ? { command: connection.command, args: maskedArgs(connection.args) }
        : { url: maskUrls(connection.url) }),
      env: connection.transport === 'stdio' ? fields : [],
      headers: connection.transport === 'stdio' ? [] : fields,
      excludedAgents: server.excludedAgents,
      addedAt: server.addedAt,
      skippedOn: connection.transport === 'sse' ? ['codex', 'opencode'] : [],
      warnings: this.warningsFor(server),
    };
  }

  /** Why a server is not started, then the env names worth a second look. */
  private warningsFor(server: StoredServer): GlobalMcpServerView['warnings'] {
    const refusal = refuseGlobalServer(server.connection, this.guardContext());
    const stopped = refusal ? [{ name: server.name, note: `Not started. ${refusal.message}` }] : [];
    return [...stopped, ...flaggedEnvNames(server.connection)];
  }

  /** Where agents can write, read fresh so a new agent's folder counts at once. */
  private guardContext(): GlobalMcpGuardContext {
    return { dorkHome: this.dorkHome, agentRoots: this.agentRoots() };
  }

  /** Say once that a saved server was left out, and why. */
  private reportDropped(name: string, refusal: GlobalMcpRefusal): void {
    if (this.reportedDropped.has(name)) return;
    this.reportedDropped.add(name);
    this.logger.warn('[mcp-servers] left a server for every agent out', {
      name,
      reason: refusal.code,
    });
  }

  /** Resolve every stored reference into memory. A missing secret drops the server. */
  private async resolveAll(): Promise<void> {
    const next = new Map<string, McpServerTransport>();
    const ctx = this.guardContext();
    for (const server of this.servers) {
      // Said at load, not only at the first turn: a hand-written server shows
      // up in the log as soon as the server starts.
      const refusal = refuseGlobalServer(server.connection, ctx);
      if (refusal) this.reportDropped(server.name, refusal);
      const values: Record<string, string> = {};
      let complete = true;
      for (const [key, value] of Object.entries(valuesOf(server.connection))) {
        // A value saved before its name counted as secret stays in the file, in
        // the clear, until a person types it again; it is not a reference.
        if (!isSecretName(key, server.secretNames) || !value.startsWith('file:')) {
          values[key] = value;
          continue;
        }
        const secret = await this.secrets.get(secretKey(server.name, key));
        if (secret === null) {
          complete = false;
          break;
        }
        values[key] = secret;
      }
      // A server missing a secret is left out rather than started without it.
      if (complete) next.set(server.name, withValues(server.connection, values));
    }
    this.resolved = next;
  }

  private async deleteSecrets(server: StoredServer): Promise<void> {
    for (const key of Object.keys(valuesOf(server.connection))) {
      if (isSecretName(key, server.secretNames)) {
        await this.secrets.delete(secretKey(server.name, key));
      }
    }
  }

  private async persist(): Promise<void> {
    const body = JSON.stringify({ version: 1, servers: this.servers }, null, 2);
    await writeFileAtomic(this.file, body, { mode: FILE_MODE });
  }
}
