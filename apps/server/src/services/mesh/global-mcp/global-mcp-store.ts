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
 * SECRET, PASSWORD, AUTH, COOKIE, or a name the person marked) is moved into the
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
 * @module services/mesh/global-mcp/global-mcp-store
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import {
  GlobalMcpServerNameSchema,
  isSecretName,
  type GlobalMcpServerInput,
  type GlobalMcpServerPatch,
  type GlobalMcpServerView,
} from '@dorkos/shared/global-mcp-schemas';
import { McpServerTransportSchema, type McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { CredentialStore } from '../../core/credential-provider.js';
import { RESERVED_MCP_SERVER_NAME } from '../agent-mcp-server-service.js';

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
      'name_taken' | 'reserved_name' | 'not_found' | 'oauth_unsupported' | 'unreadable',
    message: string
  ) {
    super(message);
    this.name = 'GlobalMcpStoreError';
  }
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

/** Persists the person's global MCP servers and serves them to runtimes. */
export class GlobalMcpStore {
  private readonly file: string;
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
   */
  constructor(
    dorkHome: string,
    private readonly secrets: CredentialStore
  ) {
    this.file = path.join(dorkHome, 'mcp', 'global-servers.json');
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
    for (const server of this.servers) {
      if (!server.enabled || server.excludedAgents.includes(agentId)) continue;
      const connection = this.resolved.get(server.name);
      if (connection) out[server.name] = toInjectable(connection);
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
      if (this.servers.some((s) => s.name === input.name)) {
        throw new GlobalMcpStoreError(
          'name_taken',
          `There's already a server named ${input.name}.`
        );
      }
      return this.put(input, new Date().toISOString());
    });
  }

  /**
   * Replace a server, secrets and all: a changed secret is typed again.
   *
   * @param name - The server to replace.
   * @param input - Its new definition. The name may not change.
   */
  replace(name: string, input: GlobalMcpServerInput): Promise<GlobalMcpServerView> {
    return this.exclusive(async () => {
      const existing = this.find(name);
      if (input.name !== name) {
        throw new GlobalMcpStoreError('name_taken', 'Remove the server to give it a new name.');
      }
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
   */
  patch(name: string, patch: GlobalMcpServerPatch): Promise<GlobalMcpServerView> {
    return this.exclusive(async () => {
      const existing = this.find(name);
      const next: StoredServer = {
        ...existing,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.excludedAgents !== undefined ? { excludedAgents: patch.excludedAgents } : {}),
      };
      this.servers = this.servers.map((s) => (s.name === name ? next : s));
      await this.persist();
      return this.view(next);
    });
  }

  /**
   * Remove a server and its stored secrets.
   *
   * @param name - The server.
   */
  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const existing = this.find(name);
      this.servers = this.servers.filter((s) => s.name !== name);
      this.resolved.delete(name);
      await this.persist();
      await this.deleteSecrets(existing);
    });
  }

  /** Run one write after every write before it, refusing all of them on an unreadable file. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(() => {
      if (this.unreadable) {
        throw new GlobalMcpStoreError(
          'unreadable',
          'The saved MCP servers could not be read, so nothing was changed.'
        );
      }
      return work();
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Store one server, moving its secret values into the credential store. */
  private async put(input: GlobalMcpServerInput, addedAt: string): Promise<GlobalMcpServerView> {
    if (input.name === RESERVED_MCP_SERVER_NAME) {
      throw new GlobalMcpStoreError('reserved_name', `${input.name} is DorkOS's own server.`);
    }
    if (input.connection.transport !== 'stdio' && input.connection.authKind === 'oauth2') {
      throw new GlobalMcpStoreError(
        'oauth_unsupported',
        'A server that signs in is added per agent for now.'
      );
    }
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
    const fields = Object.entries(valuesOf(server.connection)).map(([name, value]) =>
      isSecretName(name, server.secretNames)
        ? { name, secret: true }
        : { name, secret: false, value }
    );
    const { connection } = server;
    return {
      name: server.name,
      enabled: server.enabled,
      transport: connection.transport,
      ...(connection.transport === 'stdio'
        ? { command: connection.command, args: connection.args }
        : { url: connection.url }),
      env: connection.transport === 'stdio' ? fields : [],
      headers: connection.transport === 'stdio' ? [] : fields,
      excludedAgents: server.excludedAgents,
      addedAt: server.addedAt,
      skippedOn: connection.transport === 'sse' ? ['codex', 'opencode'] : [],
    };
  }

  /** Resolve every stored reference into memory. A missing secret drops the server. */
  private async resolveAll(): Promise<void> {
    const next = new Map<string, McpServerTransport>();
    for (const server of this.servers) {
      const values: Record<string, string> = {};
      let complete = true;
      for (const [key, value] of Object.entries(valuesOf(server.connection))) {
        if (!isSecretName(key, server.secretNames)) {
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
