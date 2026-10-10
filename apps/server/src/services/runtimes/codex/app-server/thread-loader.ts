/**
 * Makes sure a session's Codex thread is loaded, in the right process, with
 * the right config, before a turn (spec `codex-app-server-transport` §6, §9).
 *
 * A loaded thread's config is FIXED (spike 1b): `thread/resume` on a loaded
 * thread answers success and ignores new config. So everything that varies
 * between loads goes in the load params once, and the load is fingerprinted
 * (secrets excluded) to tell when a loaded thread no longer matches what a
 * turn wants — in which case it is used as is and its process is marked stale,
 * to be recycled when nothing in it is live.
 *
 * Load config carries, all over stdin and never argv or environment:
 * - `mcp_servers`: the agent's managed servers with literal `http_headers`, and
 *   the `dorkos` / connector servers authenticated by a THREAD KEY (minted
 *   here, memory only, resolved by the listener to the open turn's binding);
 * - `shell_environment_policy.set`: the agent identity token, for the commands
 *   the agent runs;
 * - `projects.<realpath cwd>.trust_level`: so Codex never writes the person's
 *   trust list (spike 2c);
 * - on credits, the provider pointing at the credits relay;
 * - `features.prevent_idle_sleep` while keep-awake applies (spec `keep-awake`),
 *   Codex's own sleep inhibitor as a second layer under DorkOS's hold.
 *
 * @module services/runtimes/codex/app-server/thread-loader
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { SessionSettings, StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import type { ConnectorThreadKeyPort } from '../../../connectors/runtime-principal-port.js';
import {
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS,
  connectorRuntimeHeaders,
} from '../../connector-tools.js';
import { DORKOS_MCP_SERVER_NAME } from '../../shared/dorkos-tool-names.js';
import { codexCreditsThreadConfig } from '../credits-launch.js';
import { withLiteralHeaders } from '../mcp-server-config.js';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import type { CodexTurnTools } from '../transport/codex-transport.js';
import type { CodexAppServerProcess } from './process-pool.js';
import { approvalPolicyFor } from './turn-parts.js';
import { isCodexRpcError } from './protocol/errors.js';
import type { SandboxMode, ThreadLoadOverrides } from './protocol/methods.js';

/** The copy a person reads when Codex lost the conversation (§6). */
export const THREAD_STARTS_FRESH_NOTICE = 'Codex no longer has this chat, so it starts fresh.';

/**
 * How long the pre-resume `thread/read` may take. A local metadata read; on a
 * timeout the resume that follows has the final word.
 */
export const THREAD_READ_TIMEOUT_MS = 5_000;

/** The copy a person reads when they archived the conversation in Codex (§6). */
export const THREAD_ARCHIVED_NOTICE = 'This chat is archived in Codex, so it starts fresh.';

/** Which home a thread loads in, and what that home's trust rule is. */
export type CodexHomeKind = 'person' | 'credits';

/** Everything one load needs. */
export interface ThreadLoadInput {
  /** The process to load in. */
  readonly process: CodexAppServerProcess;
  /** Which home it is. */
  readonly home: CodexHomeKind;
  /** DorkOS session id. */
  readonly sessionId: string;
  /** The bound thread, or `undefined`. */
  readonly boundThreadId: string | undefined;
  /** Working directory. */
  readonly cwd: string;
  /** Mode and model. */
  readonly settings: SessionSettings;
  /** The turn's tools. */
  readonly tools: CodexTurnTools;
  /** The credits relay this process's provider points at (credits home only). */
  readonly creditsRelay?: { baseUrl: string; key: string };
  /**
   * Whether Codex's own sleep inhibitor rides the load config. Part of the
   * fingerprint, so a toggle marks a process with loaded threads stale and it
   * recycles once idle, exactly like any other config change.
   */
  readonly preventIdleSleep?: boolean;
}

/** A thread ready for a turn. */
export interface LoadedThread {
  /** The thread id. */
  readonly threadId: string;
  /** The thread key minted for it, if it carries listener-backed tools. */
  readonly keyId: string | undefined;
  /** Whether the binding must be persisted at its first `turn/started`. */
  readonly needsBinding: boolean;
  /** The bound thread this one replaces (§6), if any. */
  readonly replaces: string | undefined;
  /** Something to tell the person before the turn, if any. */
  readonly notice: StreamEvent | undefined;
  /** A thread this load retired (reloaded as this one); stop routing it. */
  readonly retired?: string;
}

/** Why a compaction found nothing to summarize. */
export type NothingToCompact =
  /** The session never ran a turn: no thread, no conversation. */
  | 'empty'
  /** Codex no longer has the bound thread (deleted, archived, rollout gone). */
  | 'gone';

interface LoadedRecord {
  readonly sessionId: string;
  readonly fingerprint: string;
  /**
   * Loaded cold for a compaction alone, with none of the agent's tools. The
   * next turn keeps it only if it wants exactly that load; otherwise it is
   * reloaded with that turn's config.
   */
  compactionOnly?: boolean;
  /** Digest of the credential VALUES it loaded with (see `credentialsOf`). */
  readonly credentials: string;
  readonly keyId: string | undefined;
  /** Not yet persisted (no turn has started on it). */
  unbound: boolean;
  replaces: string | undefined;
}

/** Dependencies of {@link CodexThreadLoader}. */
export interface CodexThreadLoaderOptions {
  /** Thread keys, when the composition root wired the internal listener. */
  readonly threadKeys: () => ConnectorThreadKeyPort | undefined;
  /** Realpath seam. */
  readonly realpath?: (path: string) => string;
}

/**
 * The trust a thread loads with (spike 2c). The credits home never trusts a
 * folder; the person's home keeps the person's own recorded verdict, else
 * trusts the folder for a writable mode — exactly what exec does today, minus
 * writing it to their `config.toml`.
 *
 * @param home - Which home.
 * @param sandbox - The thread's sandbox.
 * @param recorded - The person's own verdict for this path, if any.
 */
export function trustLevelFor(
  home: CodexHomeKind,
  sandbox: SandboxMode,
  recorded: string | undefined
): 'trusted' | 'untrusted' | undefined {
  if (home === 'credits') return 'untrusted';
  if (recorded === 'trusted' || recorded === 'untrusted') return recorded;
  return sandbox === 'read-only' ? undefined : 'trusted';
}

/** Loads threads, one record per (process, thread). */
export class CodexThreadLoader {
  private readonly byProcess = new Map<string, Map<string, LoadedRecord>>();
  private readonly realpath: (path: string) => string;

  /**
   * Construct an empty loader.
   *
   * @param options - Thread keys and seams.
   */
  constructor(private readonly options: CodexThreadLoaderOptions) {
    this.realpath =
      options.realpath ??
      ((path) => {
        try {
          return fs.realpathSync(path);
        } catch {
          return path;
        }
      });
  }

  /**
   * Make sure the session's thread is loaded in `input.process` (§6's table).
   *
   * @param input - The turn's load inputs.
   */
  async ensureLoaded(input: ThreadLoadInput): Promise<LoadedThread> {
    const records = this.recordsFor(input.process);
    const desired = this.fingerprintOf(input);
    const credentials = credentialsOf(input);

    const existingId = this.loadedThreadFor(input);
    if (existingId !== undefined) {
      const record = records.get(existingId)!;
      // Loaded for a compaction alone, without tools: a loaded thread keeps
      // the config it loaded with, so unless this turn wants exactly that
      // load, reload just this thread with its config (a fork, carrying the
      // summarized history). A turn that wants no tools either uses it as is.
      if (record.compactionOnly) {
        if (record.fingerprint !== desired || record.credentials !== credentials) {
          return this.reload(input, existingId);
        }
        record.compactionOnly = false;
      }
      // Only a credential VALUE changed (a managed server's OAuth bearer was
      // refreshed): reload just this thread, never the whole home (§9).
      if (record.fingerprint === desired && record.credentials !== credentials) {
        try {
          return await this.reload(input, existingId);
        } catch (err) {
          logger.warn('[CodexAppServer] could not reload a thread with refreshed credentials', {
            sessionId: input.sessionId,
            err: String(err),
          });
          input.process.stale = true;
        }
      }
      if (record.fingerprint !== desired && !input.process.stale) {
        input.process.stale = true;
        logger.info(
          '[CodexAppServer] a loaded thread no longer matches its config; recycling when idle',
          {
            sessionId: input.sessionId,
          }
        );
      }
      return {
        threadId: existingId,
        keyId: record.keyId,
        needsBinding: record.unbound,
        replaces: record.replaces,
        notice: undefined,
      };
    }

    if (input.boundThreadId === undefined) {
      return this.start(input, records, desired, credentials, undefined);
    }
    return this.resume(input, records, desired, credentials, input.boundThreadId);
  }

  /**
   * Make sure the session's BOUND thread is loaded, for a compaction. When
   * there is nothing to summarize it says why: `'empty'` (the session never
   * bound a thread) or `'gone'` (Codex no longer has it: deleted or
   * archived). A fresh thread would hold no conversation, so none is started.
   *
   * A thread already loaded is used exactly as it is: a compaction runs no
   * tools, so the config it loaded with does not matter, and a mismatch must
   * not mark its process stale. One loaded cold here carries none of the
   * agent's tools (`input.tools` is empty), so it is marked `compactionOnly`
   * and the next turn reloads it with its own unless it wants that very load
   * ({@link ensureLoaded}).
   *
   * @param input - The compaction's load inputs; its tools are not loaded.
   */
  async ensureLoadedForCompaction(
    input: ThreadLoadInput
  ): Promise<LoadedThread | NothingToCompact> {
    const records = this.recordsFor(input.process);
    const existingId = this.loadedThreadFor(input);
    if (existingId !== undefined) {
      const record = records.get(existingId)!;
      // A thread started for a first turn that never began has nothing in it
      // (a fork waiting to bind names the thread it replaces, and has).
      if (record.unbound && record.replaces === undefined) {
        return 'empty';
      }
      return {
        threadId: existingId,
        keyId: record.keyId,
        needsBinding: record.unbound,
        replaces: record.replaces,
        notice: undefined,
      };
    }
    const threadId = input.boundThreadId;
    if (threadId === undefined) return 'empty';
    try {
      const overrides = await this.overrides(input, undefined);
      await input.process.client.request('thread/resume', { threadId, ...overrides });
    } catch (err) {
      if (isCodexRpcError(err, 'no-rollout', 'thread-not-found', 'archived')) return 'gone';
      throw err;
    }
    records.set(threadId, {
      sessionId: input.sessionId,
      fingerprint: this.fingerprintOf(input),
      compactionOnly: true,
      credentials: credentialsOf(input),
      keyId: undefined,
      unbound: false,
      replaces: undefined,
    });
    return {
      threadId,
      keyId: undefined,
      needsBinding: false,
      replaces: undefined,
      notice: undefined,
    };
  }

  /**
   * The thread this session already has loaded in `input.process`, if any:
   * its bound thread, or one started for a first turn that never got as far
   * as `turn/started`. Nothing is loaded or sent.
   *
   * @param input - The process, the session and its bound thread.
   */
  loadedThreadFor(
    input: Pick<ThreadLoadInput, 'process' | 'sessionId' | 'boundThreadId'>
  ): string | undefined {
    const records = this.byProcess.get(input.process.key);
    if (!records) return undefined;
    if (input.boundThreadId !== undefined && records.has(input.boundThreadId)) {
      return input.boundThreadId;
    }
    return [...records.entries()].find(
      ([, record]) => record.sessionId === input.sessionId && record.unbound
    )?.[0];
  }

  /**
   * Reload one loaded thread with the config this turn wants, leaving every
   * other thread in the process alone.
   *
   * A loaded thread ignores new config on `thread/resume` (spike 1b), and
   * 0.154 has no unload method, so the reload is a `thread/fork` with the new
   * config: verified on the vendored binary, the fork's MCP servers receive
   * the new header, the conversation carries over, and it works even while
   * the old thread still has a turn Codex will not stop. The session is
   * re-bound to the fork at its first `turn/started` (the binding names the
   * thread it replaces); the old thread's key is revoked and it is
   * unsubscribed, so Codex unloads it after its idle window.
   *
   * A thread that never ran a turn has no rollout, and Codex refuses to fork
   * it ("no rollout found", verified on 0.154). There is no conversation to
   * carry over, so it is started again instead, exactly as a cold resume does.
   *
   * **The restart window.** Until the fork's first `turn/started`, the
   * database still names the old thread. If DorkOS restarts in that window,
   * the next turn resumes the old thread cold in a new process, with the
   * config that turn wants: the fork had no turn of its own, so nothing is
   * lost. Pinned by "resumes the old thread cold after a restart in the window
   * before a fork binds" in `app-server-transport.test.ts`.
   *
   * @param input - The turn's load inputs.
   * @param threadId - The loaded thread to reload.
   */
  async reload(input: ThreadLoadInput, threadId: string): Promise<LoadedThread> {
    const records = this.recordsFor(input.process);
    const old = records.get(threadId);
    // The DB binding to replace: the old thread if it was bound, else whatever
    // the old unbound thread itself was going to replace.
    const replaces = old && old.unbound ? old.replaces : threadId;
    const retire = () => {
      this.dropThread(input.process, threadId);
      void input.process.client.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    };
    const key = this.mintKey(input);
    let forked: string;
    try {
      const overrides = await this.overrides(input, key?.key);
      forked = (await input.process.client.request('thread/fork', { threadId, ...overrides }))
        .thread.id;
    } catch (err) {
      if (key) this.options.threadKeys()?.revoke(key.keyId, 'superseded');
      if (!isCodexRpcError(err, 'no-rollout')) throw err;
      retire();
      const fresh = await this.start(
        input,
        records,
        this.fingerprintOf(input),
        credentialsOf(input),
        replaces
      );
      return { ...fresh, retired: threadId };
    }
    retire();
    records.set(forked, {
      sessionId: input.sessionId,
      fingerprint: this.fingerprintOf(input),
      credentials: credentialsOf(input),
      keyId: key?.keyId,
      unbound: true,
      replaces,
    });
    return {
      threadId: forked,
      keyId: key?.keyId,
      needsBinding: true,
      replaces,
      notice: undefined,
      retired: threadId,
    };
  }

  /**
   * Cold resume of a bound thread, falling back to a fresh one when Codex
   * cannot continue it (§6, §13).
   *
   * Reconciled first with `thread/read` (metadata only, nothing loaded): a
   * thread the person deleted in Codex reads "not loaded" and a resume of it
   * answers "no rollout" — the same words a never-run thread gets, so the
   * read is what tells DorkOS the conversation is gone rather than unstarted.
   * A bound thread always ran a turn (the binding is written at its first
   * `turn/started`), so either answer means Codex lost it, and the person is
   * told. An archived one reads fine and refuses the resume; it starts fresh
   * too, with its own notice, and stays archived in Codex.
   */
  private async resume(
    input: ThreadLoadInput,
    records: Map<string, LoadedRecord>,
    fingerprint: string,
    credentials: string,
    threadId: string
  ): Promise<LoadedThread> {
    const freshWith = async (message: string): Promise<LoadedThread> => {
      const fresh = await this.start(input, records, fingerprint, credentials, threadId);
      return { ...fresh, notice: { type: 'system_status', data: { message } } };
    };
    try {
      await input.process.client.request(
        'thread/read',
        { threadId },
        { timeoutMs: THREAD_READ_TIMEOUT_MS }
      );
    } catch (err) {
      if (isCodexRpcError(err, 'thread-not-found')) return freshWith(THREAD_STARTS_FRESH_NOTICE);
      // Anything else: the resume below has the final word.
    }
    const key = this.mintKey(input);
    try {
      const overrides = await this.overrides(input, key?.key);
      await input.process.client.request('thread/resume', { threadId, ...overrides });
    } catch (err) {
      if (key) this.options.threadKeys()?.revoke(key.keyId, 'superseded');
      // Deleted (or its rollout removed) in Codex. DorkOS's own history stays visible.
      if (isCodexRpcError(err, 'no-rollout', 'thread-not-found')) {
        return freshWith(THREAD_STARTS_FRESH_NOTICE);
      }
      if (isCodexRpcError(err, 'archived')) return freshWith(THREAD_ARCHIVED_NOTICE);
      throw err;
    }
    records.set(threadId, {
      sessionId: input.sessionId,
      fingerprint,
      credentials,
      keyId: key?.keyId,
      unbound: false,
      replaces: undefined,
    });
    return {
      threadId,
      keyId: key?.keyId,
      needsBinding: false,
      replaces: undefined,
      notice: undefined,
    };
  }

  private async start(
    input: ThreadLoadInput,
    records: Map<string, LoadedRecord>,
    fingerprint: string,
    credentials: string,
    replaces: string | undefined
  ): Promise<LoadedThread> {
    const key = this.mintKey(input);
    let threadId: string;
    try {
      const overrides = await this.overrides(input, key?.key);
      threadId = (await input.process.client.request('thread/start', overrides)).thread.id;
    } catch (err) {
      if (key) this.options.threadKeys()?.revoke(key.keyId, 'superseded');
      throw err;
    }
    records.set(threadId, {
      sessionId: input.sessionId,
      fingerprint,
      credentials,
      keyId: key?.keyId,
      unbound: true,
      replaces,
    });
    return { threadId, keyId: key?.keyId, needsBinding: true, replaces, notice: undefined };
  }

  /**
   * Record that a thread's binding was persisted (its first `turn/started`).
   *
   * @param process - Its process.
   * @param threadId - The thread.
   */
  markBound(process: CodexAppServerProcess, threadId: string): void {
    const record = this.byProcess.get(process.key)?.get(threadId);
    if (record) {
      record.unbound = false;
      record.replaces = undefined;
    }
  }

  /**
   * Whether a session has a thread loaded in a live process.
   *
   * @param sessionId - The session.
   */
  holdsSession(sessionId: string): boolean {
    for (const records of this.byProcess.values()) {
      for (const record of records.values()) if (record.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Forget one thread (it closed in Codex, or its session was reaped) and
   * revoke its key.
   *
   * @param process - Its process.
   * @param threadId - The thread.
   */
  dropThread(process: CodexAppServerProcess, threadId: string): void {
    const records = this.byProcess.get(process.key);
    const record = records?.get(threadId);
    if (!record) return;
    records!.delete(threadId);
    if (record.keyId) this.options.threadKeys()?.revoke(record.keyId, 'thread_unloaded');
  }

  /**
   * The threads a session has loaded, by process (to reap them).
   *
   * @param sessionId - The session.
   */
  threadsOf(sessionId: string): Array<{ processKey: string; threadId: string }> {
    const out: Array<{ processKey: string; threadId: string }> = [];
    for (const [processKey, records] of this.byProcess) {
      for (const [threadId, record] of records) {
        if (record.sessionId === sessionId) out.push({ processKey, threadId });
      }
    }
    return out;
  }

  /** Every session with a thread loaded in a live process. */
  sessionIds(): string[] {
    const ids = new Set<string>();
    for (const records of this.byProcess.values()) {
      for (const record of records.values()) ids.add(record.sessionId);
    }
    return [...ids];
  }

  /**
   * The threads loaded in one process.
   *
   * @param processKey - The process's pool key.
   */
  threadsInProcess(processKey: string): string[] {
    return [...(this.byProcess.get(processKey)?.keys() ?? [])];
  }

  private recordsFor(process: CodexAppServerProcess): Map<string, LoadedRecord> {
    let records = this.byProcess.get(process.key);
    if (!records) {
      const created = new Map<string, LoadedRecord>();
      records = created;
      this.byProcess.set(process.key, created);
      // Everything loaded here dies with the process, and so do its keys.
      process.onExit(() => {
        if (this.byProcess.get(process.key) === created) this.byProcess.delete(process.key);
        this.options.threadKeys()?.revokeProcess(process.key, 'process_exited');
      });
    }
    return records;
  }

  private mintKey(input: ThreadLoadInput): { keyId: string; key: string } | undefined {
    if (!input.tools.dorkosTools && !input.tools.connectorTools) return undefined;
    const keys = this.options.threadKeys();
    if (!keys) return undefined;
    return keys.mint({
      runtime: 'codex',
      canonicalSessionId: input.sessionId,
      canonicalCwd: input.cwd,
      processKey: input.process.key,
    });
  }

  /** The load params, with real secrets, for the wire. */
  private async overrides(
    input: ThreadLoadInput,
    threadKey: string | undefined
  ): Promise<ThreadLoadOverrides> {
    const sandbox = sandboxFor(input.settings);
    const recorded = input.home === 'person' ? await this.recordedTrust(input) : undefined;
    // The identity token is minted here, when a thread actually loads, not on
    // every turn: a loaded thread keeps the one it loaded with (spec §9).
    const agentTokenEnv =
      Object.keys(input.tools.agentTokenEnv).length === 0 && input.tools.mintAgentToken
        ? await input.tools.mintAgentToken()
        : input.tools.agentTokenEnv;
    return buildLoadOverrides(
      { ...input, tools: { ...input.tools, agentTokenEnv } },
      {
        threadKey,
        trust: trustLevelFor(input.home, sandbox, recorded),
        realCwd: this.realpath(input.cwd),
      }
    );
  }

  private async recordedTrust(input: ThreadLoadInput): Promise<string | undefined> {
    try {
      const result = await input.process.client.request('config/read', { cwd: input.cwd });
      return result.config.projects?.[this.realpath(input.cwd)]?.trust_level;
    } catch (err) {
      logger.debug('[CodexAppServer] config/read failed; applying the default trust rule', {
        err: String(err),
      });
      return undefined;
    }
  }

  /**
   * The load fingerprint: the shape of the load params with every secret and
   * every header VALUE replaced by a placeholder, so it compares what a
   * thread was loaded WITH rather than which credentials happened to be live.
   *
   * - The thread key, relay key and identity token are re-minted per load, so
   *   their values would make every turn look different.
   * - Managed MCP header values and stdio `env` values are left out on
   *   purpose: a managed server's OAuth bearer is refreshed while a thread
   *   stays loaded, and a refresh must not recycle every chat in the home.
   *   Those values have their own digest ({@link credentialsOf}); when only
   *   it changes, just that thread is reloaded ({@link CodexThreadLoader.reload}).
   *   A changed server, URL, command or header NAME marks the process stale.
   * - The trust verdict is derived from the mode, which is already in it.
   */
  private fingerprintOf(input: ThreadLoadInput): string {
    const placeholder = (record: Record<string, unknown>, value: string) =>
      Object.fromEntries(Object.keys(record).map((name) => [name, value]));
    const managedServers = Object.fromEntries(
      Object.entries(input.tools.managed.servers).map(([name, entry]) => {
        const server = entry as Record<string, unknown>;
        return [
          name,
          server.env && typeof server.env === 'object'
            ? { ...server, env: placeholder(server.env as Record<string, unknown>, '<env>') }
            : server,
        ];
      })
    );
    const identity =
      Object.keys(input.tools.agentTokenEnv).length > 0 || input.tools.mintAgentToken !== undefined;
    const shape = buildLoadOverrides(
      {
        ...input,
        tools: {
          ...input.tools,
          agentTokenEnv: identity ? { '<identity>': '<token>' } : {},
          managed: {
            servers: managedServers as CodexTurnTools['managed']['servers'],
            env: placeholder(input.tools.managed.env, '<header>') as Record<string, string>,
          },
        },
        ...(input.creditsRelay
          ? { creditsRelay: { ...input.creditsRelay, key: '<relay-key>' } }
          : {}),
      },
      { threadKey: '<thread-key>', trust: undefined, realCwd: input.cwd }
    );
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
  }
}

function sandboxFor(settings: SessionSettings): SandboxMode {
  return (MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only') as SandboxMode;
}

/**
 * Build one load's params (pure): exec's sandbox mapping, the mode's approval
 * policy (`approvalPolicyFor`), and the reviewer always the person — never a
 * model (spec §18).
 *
 * @param input - The load inputs.
 * @param secrets - The thread key, the trust verdict and the cwd's realpath.
 */
export function buildLoadOverrides(
  input: Pick<ThreadLoadInput, 'cwd' | 'settings' | 'tools' | 'creditsRelay' | 'preventIdleSleep'>,
  secrets: {
    threadKey: string | undefined;
    trust: 'trusted' | 'untrusted' | undefined;
    realCwd: string;
  }
): ThreadLoadOverrides {
  const config: Record<string, unknown> = {};
  const servers: Record<string, unknown> = { ...withLiteralHeaders(input.tools.managed) };
  if (secrets.threadKey !== undefined) {
    // Written LAST so a managed server can never shadow them.
    const headers = connectorRuntimeHeaders({
      bearer: secrets.threadKey,
      runtime: 'codex',
      canonicalCwd: input.cwd,
    });
    if (input.tools.dorkosTools) {
      servers[DORKOS_MCP_SERVER_NAME] = { url: input.tools.dorkosTools.url, http_headers: headers };
    }
    if (input.tools.connectorTools) {
      servers[CONNECTOR_RUNTIME_MCP_SERVER_NAME] = {
        url: input.tools.connectorTools.url,
        http_headers: headers,
        tool_timeout_sec: CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS / 1000,
      };
    }
  }
  if (Object.keys(servers).length > 0) config.mcp_servers = servers;
  if (Object.keys(input.tools.agentTokenEnv).length > 0) {
    config.shell_environment_policy = { set: { ...input.tools.agentTokenEnv } };
  }
  if (secrets.trust !== undefined) {
    config.projects = { [secrets.realCwd]: { trust_level: secrets.trust } };
  }
  if (input.creditsRelay) {
    Object.assign(config, codexCreditsThreadConfig(input.creditsRelay));
  }
  if (input.preventIdleSleep) config.features = { prevent_idle_sleep: true };
  return {
    cwd: input.cwd,
    ...(input.settings.model !== undefined ? { model: input.settings.model } : {}),
    approvalPolicy: approvalPolicyFor(input.settings),
    approvalsReviewer: 'user',
    sandbox: sandboxFor(input.settings),
    config,
  };
}

/**
 * Digest of the credential VALUES a load carries: managed MCP header values
 * and stdio `env` values. Never stored or logged; compared only, so a refreshed
 * OAuth bearer can reload its one thread (spec §9).
 *
 * @param input - The load inputs.
 */
function credentialsOf(input: Pick<ThreadLoadInput, 'tools'>): string {
  const servers = Object.entries(input.tools.managed.servers)
    .map(([name, server]) => [name, (server as { env?: unknown }).env ?? null])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  const headers = Object.entries(input.tools.managed.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({ servers, headers })).digest('hex');
}
