/**
 * OpenCode Session Mapper — 1:1 mapping between DorkOS sessions and OpenCode
 * sessions, with listing and history read exclusively through the SDK against
 * the managed sidecar (ADR-0308: OpenCode's store is opaque, runtime-owned —
 * never scan its SQLite database).
 *
 * ID mapping is adapter-owned and in-memory: the OpenCode server is the source
 * of truth and can always be re-listed, so a lost map is recoverable, not data
 * loss. Sessions created through DorkOS bind the caller's session UUID to the
 * new OpenCode id; sessions discovered via list (created in the OpenCode TUI,
 * or re-surfaced after a DorkOS restart) get a deterministic name-based UUID
 * derived from their OpenCode id — the same OpenCode session therefore maps to
 * the same DorkOS id across calls, mapper instances, and process restarts.
 *
 * @module services/runtimes/opencode/session-mapper
 */
import { createHash } from 'node:crypto';
import type {
  OpencodeClient,
  Session as OpenCodeSession,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  ToolPart,
} from '@opencode-ai/sdk';
import type {
  Session,
  HistoryMessage,
  HistoryToolCall,
  MessagePart,
  TextPart,
  ToolCallPart,
} from '@dorkos/shared/types';

/**
 * Narrow seam to the sidecar server-manager (task 3.3). The mapper never
 * imports a concrete manager — it only needs these two accessors.
 */
export interface OpenCodeClientProvider {
  /**
   * Client for the managed sidecar, booting it first when necessary. Used for
   * targeted operations (session create, message history) where the caller has
   * explicitly asked for a specific OpenCode session.
   *
   * @param cwd - Working directory of the requesting session; a future per-cwd
   *   sidecar pool keys on it (today's single instance ignores it)
   */
  getClient(cwd: string): Promise<OpencodeClient>;

  /**
   * The running sidecar's client, or `null` when no sidecar is up. Never
   * boots. Used by {@link OpenCodeSessionMapper.listSessions} so a cold
   * sidecar can never stall the aggregated session list.
   */
  peekClient(): OpencodeClient | null;
}

/**
 * Fixed RFC 4122 namespace for deriving DorkOS session UUIDs from OpenCode
 * session ids (name-based v5). Never change this value — derived ids must stay
 * stable across releases so re-listed OpenCode sessions keep their identity.
 */
const OPENCODE_SESSION_NAMESPACE = 'c1a7f3d2-6e48-4b0a-9f21-5d8c3e7b4a90';

/**
 * Derive a deterministic RFC 4122 v5 UUID (SHA-1, name-based) from an OpenCode
 * session id. OpenCode ids (`ses_…`) are not UUIDs, but the DorkOS `Session.id`
 * contract requires one; hashing keeps the mapping stable without persistence.
 */
function deriveDorkosSessionId(openCodeSessionId: string): string {
  const namespaceBytes = Buffer.from(OPENCODE_SESSION_NAMESPACE.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1').update(namespaceBytes).update(openCodeSessionId).digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * OpenCode `time.*` fields are epoch milliseconds (`Date.now()` upstream —
 * see NOTES.md §Session shape; flagged there for live re-verification).
 */
function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Unwrap a hey-api `fields`-style result, throwing a descriptive error when
 * the SDK reports a failure. Session-list aggregation degrades a thrown error
 * to a per-runtime warning (ADR-0310). Shared with the runtime facade for its
 * own SDK calls (session.get, session.abort, provider.list, …).
 */
export function unwrap<T>(
  result: { data?: T; error?: unknown; response?: Response },
  op: string
): T {
  if (result.data !== undefined) return result.data;
  const detail =
    result.error === undefined
      ? `HTTP ${result.response?.status ?? 'unknown'}`
      : JSON.stringify(result.error);
  throw new Error(`OpenCode ${op} failed: ${detail}`);
}

/** Project an OpenCode session onto the DorkOS `Session` contract. */
function mapSession(session: OpenCodeSession, dorkosId: string): Session {
  return {
    id: dorkosId,
    title: session.title,
    createdAt: toIso(session.time.created),
    updatedAt: toIso(session.time.updated),
    // OpenCode has no per-session permission mode; 'default' matches the
    // conservative sidecar ruleset (NOTES.md §2). The facade overlays the
    // DorkOS-stored mode once permission forwarding (task 3.6) lands.
    permissionMode: 'default',
    runtime: 'opencode',
    cwd: session.directory,
  };
}

const TOOL_STATUS_MAP = {
  pending: 'pending',
  running: 'running',
  completed: 'complete',
  error: 'error',
} as const satisfies Record<ToolPart['state']['status'], ToolCallPart['status']>;

/** Map an OpenCode tool part to a `ToolCallPart` (+ `HistoryToolCall` when finished). */
function mapToolPart(part: ToolPart): { part: ToolCallPart; call?: HistoryToolCall } {
  const { state } = part;
  const result =
    state.status === 'completed'
      ? state.output
      : state.status === 'error'
        ? state.error
        : undefined;
  const toolCallPart: ToolCallPart = {
    type: 'tool_call',
    toolCallId: part.callID,
    toolName: part.tool,
    input: JSON.stringify(state.input),
    result,
    status: TOOL_STATUS_MAP[state.status],
  };
  // HistoryToolCall.status is the literal 'complete' (schema constraint), so
  // only finished tools are recorded there — errored calls carry their error
  // text as the result; in-flight tools surface through `parts` alone.
  const call: HistoryToolCall | undefined =
    state.status === 'completed' || state.status === 'error'
      ? {
          toolCallId: part.callID,
          toolName: part.tool,
          input: toolCallPart.input,
          result,
          status: 'complete',
        }
      : undefined;
  return { part: toolCallPart, call };
}

/** Append a text part, merging into a trailing text part like the Claude transcript parser. */
function appendText(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    last.text += '\n' + text;
  } else {
    parts.push({ type: 'text', text });
  }
}

/**
 * Project one OpenCode message (+ its parts) onto a `HistoryMessage`.
 *
 * Minimal-but-correct mapping (task 3.5): text, reasoning, and tool parts.
 * Structural parts (step-start/step-finish, snapshot, patch, agent, retry,
 * subtask, file, compaction) have no history projection and are skipped;
 * messages left with no mapped parts return `null` and are dropped, mirroring
 * the Claude transcript parser.
 */
function mapHistoryMessage(entry: {
  info: OpenCodeMessage;
  parts: OpenCodePart[];
}): HistoryMessage | null {
  const { info, parts } = entry;
  const mappedParts: MessagePart[] = [];
  const toolCalls: HistoryToolCall[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      // `ignored` text never renders; `synthetic` user text is SDK-injected
      // (command expansions, system context), never user-authored — the same
      // content the Claude parser suppresses via `isMeta`.
      if (part.ignored || !part.text) continue;
      if (info.role === 'user' && part.synthetic) continue;
      appendText(mappedParts, part.text);
    } else if (part.type === 'reasoning') {
      if (part.text) mappedParts.push({ type: 'thinking', text: part.text, isStreaming: false });
    } else if (part.type === 'tool') {
      const mapped = mapToolPart(part);
      mappedParts.push(mapped.part);
      if (mapped.call) toolCalls.push(mapped.call);
    }
  }

  if (mappedParts.length === 0) return null;

  const content = mappedParts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();

  if (info.role === 'user') {
    // User messages carry content only (no parts), matching the Claude parser.
    return { id: info.id, role: 'user', content, timestamp: toIso(info.time.created) };
  }
  return {
    id: info.id,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    parts: mappedParts,
    timestamp: toIso(info.time.created),
  };
}

/**
 * Maps DorkOS sessions 1:1 to OpenCode sessions and reads listing/history
 * through the SDK against the managed sidecar. See the module doc for the
 * id-mapping model.
 */
export class OpenCodeSessionMapper {
  /** DorkOS session id -> OpenCode session id. */
  private readonly dorkosToOpenCode = new Map<string, string>();
  /** OpenCode session id -> DorkOS session id. */
  private readonly openCodeToDorkos = new Map<string, string>();

  constructor(private readonly provider: OpenCodeClientProvider) {}

  /**
   * Create or resolve the OpenCode session bound to a DorkOS session.
   *
   * Resolves the existing binding when one is known; otherwise creates a new
   * OpenCode session in the session's working directory (subsequent
   * session-scoped SDK calls auto-route by the stored directory — NOTES.md §1)
   * and binds it.
   *
   * @param dorkosSessionId - DorkOS session identifier
   * @param opts - Session context
   * @param opts.cwd - Per-session working directory, passed as `?directory=`
   * @param opts.title - Optional initial session title
   * @returns The bound OpenCode session id
   */
  async ensureSession(
    dorkosSessionId: string,
    opts: { cwd: string; title?: string }
  ): Promise<string> {
    const existing = this.dorkosToOpenCode.get(dorkosSessionId);
    if (existing) return existing;

    const client = await this.provider.getClient(opts.cwd);
    const created = unwrap(
      await client.session.create({
        body: opts.title === undefined ? {} : { title: opts.title },
        query: { directory: opts.cwd },
      }),
      'session.create'
    );
    this.link(dorkosSessionId, created.id);
    return created.id;
  }

  /**
   * Look up the OpenCode session bound to a DorkOS session, if known.
   *
   * @param dorkosSessionId - DorkOS session identifier
   */
  getOpenCodeSessionId(dorkosSessionId: string): string | undefined {
    return this.dorkosToOpenCode.get(dorkosSessionId);
  }

  /**
   * Resolve (or mint) the DorkOS id for an OpenCode session discovered outside
   * `ensureSession` — list results, SSE events (task 3.4). Returns the existing
   * binding when known, otherwise records and returns the deterministic derived
   * UUID.
   *
   * @param openCodeSessionId - OpenCode session identifier (`ses_…`)
   */
  adoptOpenCodeSession(openCodeSessionId: string): string {
    const existing = this.openCodeToDorkos.get(openCodeSessionId);
    if (existing) return existing;
    const derived = deriveDorkosSessionId(openCodeSessionId);
    this.dorkosToOpenCode.set(derived, openCodeSessionId);
    this.openCodeToDorkos.set(openCodeSessionId, derived);
    return derived;
  }

  /**
   * List OpenCode sessions for a project directory as DorkOS sessions.
   *
   * Child (subtask) sessions are excluded — they are agent-internal, not user
   * sessions. A cold sidecar returns `[]` immediately: `peekClient()` never
   * boots, because session-list aggregation runs on a 2s per-runtime budget
   * (spec §Performance / `aggregate-session-list.ts`) and no sidecar means
   * there are no OpenCode sessions to show anyway.
   *
   * @param projectDir - Working directory, passed as `?directory=`
   */
  async listSessions(projectDir: string): Promise<Session[]> {
    const client = this.provider.peekClient();
    if (!client) return [];

    const listed = unwrap(
      await client.session.list({ query: { directory: projectDir } }),
      'session.list'
    );
    return listed
      .filter((session) => session.parentID === undefined)
      .map((session) => mapSession(session, this.adoptOpenCodeSession(session.id)));
  }

  /**
   * Fork the OpenCode session bound to a DorkOS session — OpenCode supports
   * branching natively (`POST /session/{id}/fork`), optionally up to a
   * specific message (`HistoryMessage.id` IS the OpenCode message id).
   *
   * @param projectDir - Working directory of the requesting session
   * @param dorkosSessionId - Source DorkOS session identifier
   * @param opts - Optional fork parameters
   * @param opts.upToMessageId - Fork the conversation up to this message
   * @param opts.title - Title for the forked session
   * @returns The forked session (bound to a fresh derived DorkOS id), or null
   *   when the source session has no OpenCode binding
   */
  async forkSession(
    projectDir: string,
    dorkosSessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    const openCodeId = this.dorkosToOpenCode.get(dorkosSessionId);
    if (!openCodeId) return null;

    const client = await this.provider.getClient(projectDir);
    let forked = unwrap(
      await client.session.fork({
        path: { id: openCodeId },
        body: opts?.upToMessageId === undefined ? {} : { messageID: opts.upToMessageId },
      }),
      'session.fork'
    );
    if (opts?.title !== undefined) {
      forked = unwrap(
        await client.session.update({ path: { id: forked.id }, body: { title: opts.title } }),
        'session.update'
      );
    }
    return mapSession(forked, this.adoptOpenCodeSession(forked.id));
  }

  /**
   * Rename the OpenCode session bound to a DorkOS session, persisting the
   * title in OpenCode's own store. No-op when the session has no binding yet
   * (the registry still carries the title for this server's lifetime).
   *
   * @param projectDir - Working directory of the requesting session
   * @param dorkosSessionId - DorkOS session identifier
   * @param title - New display title
   */
  async renameSession(projectDir: string, dorkosSessionId: string, title: string): Promise<void> {
    const openCodeId = this.dorkosToOpenCode.get(dorkosSessionId);
    if (!openCodeId) return;
    const client = await this.provider.getClient(projectDir);
    unwrap(
      await client.session.update({ path: { id: openCodeId }, body: { title } }),
      'session.update'
    );
  }

  /**
   * Read a session's full message history through the SDK.
   *
   * Boots the sidecar when needed — a targeted history read means the caller
   * has an OpenCode session open, and the opaque store leaves the SDK as the
   * only source. An unknown id triggers one re-list to rebuild bindings from
   * the server (recovers deterministic derived ids after a restart).
   *
   * @param projectDir - Working directory of the requesting session
   * @param sessionId - DorkOS session identifier
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    const client = await this.provider.getClient(projectDir);

    let openCodeId = this.dorkosToOpenCode.get(sessionId);
    if (!openCodeId) {
      const listed = unwrap(
        await client.session.list({ query: { directory: projectDir } }),
        'session.list'
      );
      for (const session of listed) this.adoptOpenCodeSession(session.id);
      openCodeId = this.dorkosToOpenCode.get(sessionId);
    }
    if (!openCodeId) {
      throw new Error(`No OpenCode session mapped to DorkOS session ${sessionId}`);
    }

    // Session-scoped calls need no directory: the server routes by the
    // session's stored directory (NOTES.md §1).
    const entries = unwrap(
      await client.session.messages({ path: { id: openCodeId } }),
      'session.messages'
    );

    const messages: HistoryMessage[] = [];
    for (const entry of entries) {
      const mapped = mapHistoryMessage(entry);
      if (mapped) messages.push(mapped);
    }
    return messages;
  }

  /**
   * Bind a DorkOS session to an OpenCode session, authoritatively: any stale
   * entry for either key (e.g. a derived adoption that raced the create) is
   * removed so the mapping stays strictly 1:1.
   */
  private link(dorkosSessionId: string, openCodeSessionId: string): void {
    const staleOpenCode = this.dorkosToOpenCode.get(dorkosSessionId);
    if (staleOpenCode) this.openCodeToDorkos.delete(staleOpenCode);
    const staleDorkos = this.openCodeToDorkos.get(openCodeSessionId);
    if (staleDorkos) this.dorkosToOpenCode.delete(staleDorkos);
    this.dorkosToOpenCode.set(dorkosSessionId, openCodeSessionId);
    this.openCodeToDorkos.set(openCodeSessionId, dorkosSessionId);
  }
}
