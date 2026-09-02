/**
 * OpenCode Session Mapper — 1:1 mapping between DorkOS sessions and OpenCode
 * sessions, with listing and history read exclusively through the SDK against
 * the managed sidecar (ADR-0308: OpenCode's store is opaque, runtime-owned —
 * never scan its SQLite database).
 *
 * ID mapping is adapter-owned: sessions created through DorkOS bind the
 * caller's session UUID to the new OpenCode id; sessions discovered via list
 * (created in the OpenCode TUI) get a deterministic name-based UUID derived
 * from their OpenCode id. Bindings write through to the durable
 * {@link OpenCodeSessionMapStore} (`opencode_sessions`) and hydrate back at
 * construction, so the DorkOS-facing id is STABLE across server restarts —
 * before this, the in-memory-only map forgot DorkOS-created bindings on
 * restart and the first re-list re-keyed the same OpenCode session under a
 * new derived id, permanently 404ing the original (DOR-251).
 *
 * @module services/runtimes/opencode/session-mapper
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
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
  ErrorPart,
  ImagePart,
  MessagePart,
  TextPart,
  ToolCallPart,
} from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { mapMessageError } from './history-error-part.js';
// Direct module import, NOT the attachments barrel: the barrel re-exports the
// local store, which imports `node:fs`, and this module's import graph is
// filesystem-free by test guard (ADR-0308). `deriveSessionAttachmentId` needs
// only `node:crypto`, which is already here.
import { deriveSessionAttachmentId } from '../../session/attachments/session-attachment-id.js';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  displayableMime,
  storableImageExtension,
} from '../../session/attachments/session-media-types.js';
import type { SessionAttachmentStore } from '../../session/attachments/session-attachment-store.js';
import { SESSION_LIST_LIMIT, SESSION_REBUILD_LIMIT } from './runtime-constants.js';

/**
 * Narrow seam to the durable sessionId <-> OpenCode-session-id store
 * (`OpenCodeSessionMap` over `opencode_sessions` in production, an in-memory
 * fake in tests). The mapper hydrates its in-memory maps from it at
 * construction and writes every binding through — which is what keeps the
 * DorkOS-facing session id stable across server restarts (DOR-251).
 *
 * CONTRACT: neither method may throw. The mapper's import graph is
 * filesystem-free by test guard (ADR-0308), so it cannot log — implementations
 * own their resilience (warn-and-degrade), and a persistence failure must
 * degrade to in-memory-only bindings, never break a live session or boot.
 */
export interface OpenCodeSessionMapStore {
  /** Persist a binding, replacing any existing row on either key (strictly 1:1). */
  bind(sessionId: string, ocSessionId: string): void;
  /** All persisted bindings, for hydration at construction. */
  listAll(): { sessionId: string; ocSessionId: string }[];
}

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
 * Query for `GET /session`, including the three params the sidecar accepts but
 * the GENERATED SDK TYPES OMIT (`@opencode-ai/sdk@1.17.13` declares only
 * `directory`). All three were read off the running sidecar's own OpenAPI
 * document (`GET /doc`) and driven live, so this is a gap in the generated
 * client, not an unsupported call:
 *
 * - `limit` — lifts the silent 100-session cap ({@link SESSION_LIST_LIMIT}).
 * - `roots` — drops child (subtask) sessions SERVER-side, so the cap is spent
 *   only on real user sessions. Without it the cap is applied first and the
 *   client-side `parentID` filter then removes rows from an already-truncated
 *   page, so N child sessions cost the user N visible ones.
 * - `scope` — widens the read past `directory`, which the sidecar matches by
 *   EXACT STRING EQUALITY: a session started in `<project>/packages/api` is
 *   invisible to a `directory=<project>` read, which is why one never appeared
 *   in its own project's list (DOR-674).
 *
 * `scope` is an enum the sidecar validates (`scope=bogus` answers 400), so it
 * cannot be aimed at a directory subtree — the only member is `project`, and on
 * the pinned build every worktree reports `projectID: "global"`, which makes
 * that read effectively machine-wide (live-verified 2026-08-25 on 1.18.15: two
 * unrelated git projects listed each other's sessions). DorkOS therefore treats
 * it as nothing more than "the widest list the sidecar will give" and applies
 * its own subtree filter — see {@link OpenCodeSessionMapper.listSessions}.
 * Owning the filter is also what keeps the behavior stable if a later build
 * repairs `projectID`: a repaired `scope=project` narrows to the git worktree,
 * still a superset of the sessions under any project dir inside it.
 *
 * An older sidecar that predates any of these ignores it (unknown query params
 * are dropped, verified live) and simply falls back to the capped,
 * exact-directory behavior — never an error.
 */
interface SessionListQuery {
  directory: string;
  limit: number;
  /** Omitted where child sessions must also be adopted (id-binding rebuilds). */
  roots?: true;
  /** Always `'project'`; the sidecar rejects any other value. */
  scope: 'project';
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
  // Only FINISHED tools are recorded there — an in-flight one surfaces through
  // `parts` alone. An errored one now says so, rather than being recorded
  // `complete` with its error text as the result: history's status widened past
  // the literal `'complete'` in DOR-1293, precisely because "finished" and
  // "succeeded" are not the same claim.
  const call: HistoryToolCall | undefined =
    state.status === 'completed' || state.status === 'error'
      ? {
          toolCallId: part.callID,
          toolName: part.tool,
          input: toolCallPart.input,
          result,
          status: toolCallPart.status,
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
 * Resolve one image a history read found into a renderable part, or `null` when
 * it cannot be shown.
 *
 * Injected rather than imported so this module stays filesystem-free
 * (ADR-0308): the resolver closes over the attachment store, which does touch
 * the disk, and lives on the mapper INSTANCE.
 */
type HistoryMediaResolver = (
  file: OpenCodeFilePart,
  identity: readonly string[]
) => Promise<ImagePart | ErrorPart | null>;

/**
 * The honest remainder when a picture cannot be projected at all — no store to
 * keep it, or a media type the store refuses (SVG is a stored-XSS vector, not
 * an oversight). A turn whose only output was such an image used to map to no
 * parts and vanish on reload (DOR-1671); it now keeps its place in the
 * transcript with this part, and the raw bytes never ride along.
 *
 * A typed `error` part, not prose, for the live path's own reason
 * (`media-capture.ts`): prose in the transcript reads as something the model
 * said, ends up in the message `content`, and gets quoted back in excerpts as
 * the agent's words. An error part renders as the same chip the live stream
 * shows, so the two surfaces of one turn tell one story.
 *
 * @param message - What a person is told in place of the image, worded
 *   identically to the live path's `mediaError` copy for the same condition.
 */
function unshowableImagePart(message: string): ErrorPart {
  return { type: 'error', message, category: 'execution_error' };
}

/** The `file` member of OpenCode's part union, named for readability. */
type OpenCodeFilePart = Extract<OpenCodePart, { type: 'file' }>;

/**
 * Project one OpenCode message (+ its parts) onto a `HistoryMessage`.
 *
 * Text, reasoning, tool and IMAGE parts. Structural parts (step-start/
 * step-finish, snapshot, patch, agent, retry, subtask, compaction) have no
 * history projection and are skipped; messages left with no mapped parts return
 * `null` and are dropped, mirroring the Claude transcript parser.
 *
 * **`file` parts used to be in that skipped list, and that was a bug with a
 * sharp edge.** A turn whose only part was an image mapped to nothing, hit the
 * empty check below, and vanished from the transcript entirely — not a missing
 * picture in a visible turn, a missing turn. Images now map, and an image whose
 * BYTES are gone still maps: {@link OpenCodeSessionMapper.historyMediaResolver}
 * projects a part pointing at where they would be, so the reader gets an
 * "image not available" row with the turn intact around it rather than a
 * message that disappeared.
 *
 * The last hole closed with DOR-1671: a media type the store could never have
 * held (a generated SVG, AVIF, BMP or HEIC), or a mapper wired with no store at
 * all, now degrades to {@link unshowableImagePart} instead of `null` —
 * so a turn whose only output was such an image keeps its place here rather
 * than mapping to no parts and being dropped.
 *
 * A message whose ONLY content is its message-level `error` still returns a
 * message (DOR-1666): OpenCode records a turn that failed before the model
 * said anything as an assistant message with zero parts, and dropping it
 * erased the failure from every reopened transcript.
 *
 * Images ride the ASSISTANT parts array. A user's own attachment is also a
 * `file` part, and it is deliberately not projected here: user history messages
 * carry `content` and no parts at all in this mapper, so surfacing one would be
 * a separate change to the input direction (see the module doc's note).
 */
async function mapHistoryMessage(
  entry: {
    info: OpenCodeMessage;
    parts: OpenCodePart[];
  },
  resolveMedia: HistoryMediaResolver
): Promise<HistoryMessage | null> {
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
      // Whatever the tool returned that was not text. Read from the SAME field
      // the live mapper reads (`ToolStateCompleted.attachments`) under the SAME
      // identity components, so a picture streamed live and the one read back
      // from history are one file at one URL, not two copies.
      if (part.state.status === 'completed') {
        for (const [index, attachment] of (part.state.attachments ?? []).entries()) {
          const image = await resolveMedia(attachment, ['tool', part.callID, String(index)]);
          if (image) mappedParts.push(image);
        }
      }
    } else if (part.type === 'file' && info.role === 'assistant') {
      const image = await resolveMedia(part, ['part', part.id]);
      if (image) mappedParts.push(image);
    }
  }

  // The turn's failure, appended after whatever the agent managed to say —
  // the same order the log-backed history fold builds a failed turn in. Only
  // an assistant message can carry one; `mapMessageError` suppresses interrupts.
  // (DOR-1666 — a message whose ONLY content is its error still returns a
  // message, so a turn that failed before the model spoke survives a reload.)
  const errorPart = info.role === 'assistant' ? mapMessageError(info.error) : null;
  if (errorPart) mappedParts.push(errorPart);

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
  /**
   * Whether this sidecar has been observed honouring `limit` (see
   * {@link OpenCodeSessionMapper.assertLimitHonoured}). Latches on the first
   * pass so the probe costs one request per mapper rather than one per
   * listing. Scoped to the mapper, not the process: a sidecar swapped for a
   * differently-behaving build UNDER a live mapper keeps the old verdict until
   * DorkOS restarts — accepted, because the mapper is constructed with the
   * runtime and a sidecar upgrade in place is not a path DorkOS drives.
   */
  private limitProven = false;

  /**
   * @param provider - Sidecar client source
   * @param store - Durable binding store; when provided, persisted bindings
   *   hydrate the in-memory maps here so DorkOS-facing ids survive a server
   *   restart (DOR-251). Omitted in tests that don't exercise persistence.
   */
  constructor(
    private readonly provider: OpenCodeClientProvider,
    private readonly store?: OpenCodeSessionMapStore,
    /**
     * Where a history read re-materializes images, or `null` when the runtime
     * was wired without a store. Nothing here writes bytes eagerly: a picture
     * already on disk costs a `stat`, and one that is not gets written once,
     * under the same deterministic id the live turn used.
     */
    private readonly attachments: SessionAttachmentStore | null = null
  ) {
    if (!store) return;
    for (const { sessionId, ocSessionId } of store.listAll()) {
      this.dorkosToOpenCode.set(sessionId, ocSessionId);
      this.openCodeToDorkos.set(ocSessionId, sessionId);
    }
  }

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
   * Targeted single-session read for a KNOWN binding, booting the sidecar
   * when needed (same reasoning as `getMessageHistory`: the caller asked for
   * a specific session, so the boot cost is justified — unlike `listSessions`
   * which must return fast on a cold sidecar). Without this, a bookmarked
   * session id would 404 after a server restart until something else booted
   * the sidecar (DOR-251). Returns null for an unknown binding (no boot), a
   * session deleted upstream, or an unreachable sidecar — the AgentRuntime
   * `getSession` contract is "Session or null, never a throw".
   *
   * @param projectDir - Working directory of the requesting session
   * @param dorkosSessionId - DorkOS session identifier
   */
  async getSession(projectDir: string, dorkosSessionId: string): Promise<Session | null> {
    const openCodeId = this.dorkosToOpenCode.get(dorkosSessionId);
    if (!openCodeId) return null;
    try {
      const client = await this.provider.getClient(projectDir);
      const result = await client.session.get({ path: { id: openCodeId } });
      if (result.data === undefined) return null;
      return mapSession(result.data, dorkosSessionId);
    } catch {
      return null;
    }
  }

  /**
   * Resolve (or mint) the DorkOS id for an OpenCode session discovered outside
   * `ensureSession` — list results, SSE events (task 3.4). Returns the existing
   * binding when known (including bindings hydrated from the durable store, so
   * a DorkOS-created session keeps its ORIGINAL id across restarts — DOR-251),
   * otherwise records and returns the deterministic derived UUID.
   *
   * Derived adoptions are deliberately NOT written to the durable store: the
   * derivation is a pure function of the OpenCode id, so the same DorkOS id is
   * re-minted after any restart — persisting would only add a write to the
   * listing path for no added stability.
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
   * A project's sessions are the ones started ANYWHERE INSIDE it, not only the
   * ones started at its top folder: `opencode` run in `<project>/packages/api`
   * stores that subfolder as the session's directory, and the sidecar's
   * `?directory=` filter is exact string equality, so such a session appeared
   * in no list at all (DOR-674). The read is therefore widened with `scope` and
   * narrowed back here by `isWithinDirectory` from `@dorkos/shared/paths` — the
   * SAME predicate the server's per-agent fan-out and the client's session
   * selector apply to this list downstream, because three spellings of one rule
   * is three chances to disagree about which sessions a project has. Each
   * session keeps its OWN directory as `cwd`, so a row still says where it is
   * really running.
   *
   * Child (subtask) sessions are excluded — they are agent-internal, not user
   * sessions. A cold sidecar returns `[]` immediately: `peekClient()` never
   * boots, because session-list aggregation runs on a 2s per-runtime budget
   * (spec §Performance / `aggregate-session-list.ts`) and no sidecar means
   * there are no OpenCode sessions to show anyway.
   *
   * Reads up to {@link SESSION_LIST_LIMIT} root sessions. Genuine overflow
   * REJECTS instead of returning the page, because the sidecar reports no
   * total and offers no offset paging to fetch the remainder (`start` is a
   * timestamp filter, not a cursor — verified live). Aggregation degrades the
   * rejection to a per-runtime `warnings[]` entry (ADR-0310), so the list is
   * never silently short. The budget is spent on the WIDENED read, so overflow
   * now means "too many sessions to read past", not "too many in this project"
   * — the message says so, because a user looking at a 3-session project would
   * otherwise be told that project has more than a thousand.
   *
   * @param projectDir - ABSOLUTE working directory; sessions under it are included
   * @throws If `projectDir` is not absolute — the membership rule refuses to
   *   guess a working directory, so a relative path would quietly match nothing
   *   and read as "this project has no OpenCode sessions". Aggregation turns
   *   this into a per-runtime warning (ADR-0310), which says so out loud.
   */
  async listSessions(projectDir: string): Promise<Session[]> {
    if (!path.isAbsolute(projectDir)) {
      throw new Error(
        `OpenCode session listing needs a full folder path, but got "${projectDir}".`
      );
    }
    const client = this.provider.peekClient();
    if (!client) return [];

    const { rows, saturated } = await this.listWithBudget(client, {
      directory: projectDir,
      budget: SESSION_LIST_LIMIT,
      roots: true,
    });
    if (saturated) {
      throw new Error(
        `OpenCode has more than ${SESSION_LIST_LIMIT} sessions on this machine, so DorkOS could not read far enough to be sure this list is complete. Showing none is safer than showing a list that looks complete.`
      );
    }
    return rows
      .filter(
        (session) =>
          session.parentID === undefined && isWithinDirectory(session.directory, projectDir)
      )
      .map((session) => mapSession(session, this.adoptOpenCodeSession(session.id)));
  }

  /**
   * One `GET /session` read whose result is provably complete or provably
   * truncated — never ambiguously either.
   *
   * Asks for `budget + 1`. Since the sidecar applies no clamp of its own, a
   * response of `budget + 1` rows proves MORE exist, while exactly `budget`
   * proves that is all there is: the sentinel row is what separates "exactly
   * 1000 exist" from "more than 1000 exist", so a project sitting precisely on
   * the ceiling is served rather than rejected.
   *
   * Any page that did NOT overflow is a page some unknown cap could have
   * produced, so the first such page proves `limit` is still live before the
   * result is trusted — see {@link OpenCodeSessionMapper.assertLimitHonoured}.
   * Deliberately not keyed to the observed default of 100: that number belongs
   * to the sidecar, not to DorkOS, and a build that dropped `limit` AND moved
   * its default would have walked straight through a check pinned to it.
   * Overflowing pages need no probe — returning `budget + 1` rows is itself
   * proof that no smaller cap was applied.
   *
   * Always reads at `scope: 'project'`. Both callers need sessions from the
   * project's SUBFOLDERS as well as its top folder, and `?directory=` alone
   * matches one exact string (DOR-674) — the caller that needs a narrower
   * answer filters the rows it got, which is cheap, while a row the sidecar
   * never sent cannot be recovered at all.
   *
   * @param client - Sidecar client to read through
   * @param opts - Read parameters
   * @param opts.directory - Working directory, passed as `?directory=`
   * @param opts.budget - Rows allowed before the read counts as truncated
   * @param opts.roots - Exclude child sessions server-side
   * @returns The rows read, and whether more exist beyond them
   */
  private async listWithBudget(
    client: OpencodeClient,
    opts: { directory: string; budget: number; roots?: true }
  ): Promise<{ rows: OpenCodeSession[]; saturated: boolean }> {
    const query: SessionListQuery = {
      directory: opts.directory,
      limit: opts.budget + 1,
      scope: 'project',
      ...(opts.roots === undefined ? {} : { roots: opts.roots }),
    };
    const rows = unwrap(await client.session.list({ query }), 'session.list');
    // `>= 2` keeps empty and single-session projects out of it: a one-row
    // answer is what an honouring sidecar gives the probe anyway, so such a
    // page can never discriminate and probing it would only add a request.
    if (!this.limitProven && rows.length >= 2 && rows.length <= opts.budget) {
      await this.assertLimitHonoured(client, opts.directory);
      this.limitProven = true;
    }
    return { rows, saturated: rows.length > opts.budget };
  }

  /**
   * Prove the sidecar still honours `limit`, or throw.
   *
   * `limit` is undeclared in the generated SDK types, so NO type-checker sees
   * it and a sidecar that renames or drops it fails silently — unknown query
   * params are ignored, not rejected (verified live). Its own default cap
   * would simply return, comfortably under the budget, so the saturation guard
   * would never fire: exactly the invisible-truncation bug this module exists
   * to end, re-entering through the fix for it.
   *
   * Asks for ONE row, which is the whole point — a sidecar honouring `limit`
   * can only answer with one, whatever its default cap happens to be, so this
   * catches any cap rather than one particular value. Probes the BEHAVIOUR
   * relied on rather than reading `GET /doc`, which would only prove the
   * parameter is still documented, and a spec can advertise a param the
   * implementation drops.
   *
   * Runs once per mapper (see `limitProven`): the answer is a property of the
   * sidecar build, not of any one listing.
   *
   * @param client - Sidecar client to probe
   * @param directory - Working directory, passed as `?directory=`
   */
  private async assertLimitHonoured(client: OpencodeClient, directory: string): Promise<void> {
    // Same `scope` as the read it vouches for: a build that honoured `limit`
    // for an exact-directory read but dropped it for the widened one would
    // otherwise pass a probe that never exercises the query actually used.
    const query: SessionListQuery = { directory, limit: 1, scope: 'project' };
    const probe = unwrap(await client.session.list({ query }), 'session.list');
    if (probe.length > 1) {
      throw new Error(
        'This version of OpenCode ignored the session limit DorkOS asked for, so DorkOS cannot tell whether this list is complete.'
      );
    }
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
      // Deliberately NO `roots`: this rebuild must be able to bind a CHILD
      // session's id too, which is why it gets its own (larger) budget — see
      // SESSION_REBUILD_LIMIT. Under the default 100-session cap, opening a
      // session older than the 100 most recent could not resolve its id at all
      // and its history 404'd.
      //
      // Unfiltered by design, unlike `listSessions`: the row being searched for
      // may live in a SUBFOLDER of the project (DOR-674), and every row here
      // only mints a deterministic derived id — adopting one from outside the
      // project costs a map entry and changes nothing a user can see, while
      // skipping one strands a session the list already showed.
      const { rows, saturated } = await this.listWithBudget(client, {
        directory: projectDir,
        budget: SESSION_REBUILD_LIMIT,
      });
      for (const session of rows) this.adoptOpenCodeSession(session.id);
      openCodeId = this.dorkosToOpenCode.get(sessionId);
      // Only a MISS against a truncated read is unresolvable. Absence from a
      // complete read is real absence; absence from a truncated one says
      // nothing, and reporting it as "no such session" would blame the session
      // for the adapter having stopped reading.
      if (!openCodeId && saturated) {
        throw new Error(
          `OpenCode has more than ${SESSION_REBUILD_LIMIT} sessions on this machine, so DorkOS could not search far enough to open this one. The session is not missing — the search was cut short.`
        );
      }
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

    const resolveMedia = this.historyMediaResolver(sessionId);
    const messages: HistoryMessage[] = [];
    for (const entry of entries) {
      const mapped = await mapHistoryMessage(entry, resolveMedia);
      if (mapped) messages.push(mapped);
    }
    return messages;
  }

  /**
   * A resolver that re-materializes this session's images through the
   * attachment store.
   *
   * Idempotent and cheap on the common path: an image already on disk costs one
   * `stat` (`peek`), and only a first read of a transcript actually decodes
   * bytes. That is what makes reopening a session safe to do repeatedly — the
   * deterministic attachment id means a second read finds the first read's file
   * rather than writing a second one.
   *
   * **A picture that cannot be re-materialized still projects a part.** Not
   * every source survives a history read: `storeHistoryImage` rebuilds only
   * from a `data:` URI, because this module may not touch the disk (ADR-0308),
   * so a `file://`-sourced image the retention sweep has since collected cannot
   * be brought back here. Returning `null` for that case looked harmless and
   * was not — a message whose ONLY part was that image maps to no parts,
   * `mapHistoryMessage` drops it, and the whole turn disappears from the
   * transcript. That is precisely the defect this change exists to fix, and it
   * would have been reintroduced by its own sweep. So an unresolvable image
   * projects a part pointing at where the bytes WOULD be (`urlFor`), the fetch
   * 404s, and the reader gets the honest "this image is not available" row with
   * the turn intact around it.
   *
   * `null` is reserved for what genuinely is not a picture at all: a non-image
   * mime. A picture that cannot be projected — no store wired, or a media type
   * the store deliberately refuses — degrades to the placeholder instead
   * (DOR-1671), so the turn around it survives a reload.
   *
   * @param sessionId - The DorkOS session whose history is being read.
   */
  private historyMediaResolver(sessionId: string): HistoryMediaResolver {
    const store = this.attachments;
    return async (file, identity) => {
      const mime = file.mime.toLowerCase();
      if (!mime.startsWith('image/')) return null;
      // A picture with nowhere to live is still a picture the transcript is
      // entitled to mention (DOR-1671): no store, or a media type the store
      // deliberately refuses, degrades to the typed placeholder rather than to
      // a dropped turn. Copy matches the live path's mediaError for the same
      // condition, so live and reload tell one story.
      if (!store) {
        return unshowableImagePart(
          'This agent is not set up to keep images, so one was not saved.'
        );
      }
      if (storableImageExtension(file.mime) === null) {
        return unshowableImagePart(
          `A session cannot store ${displayableMime(file.mime)} — only PNG, JPEG, GIF and WebP images.`
        );
      }
      const attachmentId = deriveSessionAttachmentId(identity);
      const alt = file.filename !== undefined ? { alt: file.filename } : {};
      try {
        const existing = await store.peek(sessionId, attachmentId, file.mime);
        if (existing) {
          // This transcript still references the picture, which makes it in
          // use — say so, or retention reads a file nobody has rewritten since
          // it was created as a file nobody wants (`SessionAttachmentStore.touch`).
          void store
            .touch(sessionId, attachmentId, storableImageExtension(file.mime) ?? '')
            .catch(() => {});
          return { type: 'image', attachmentId, ...existing, ...alt };
        }
        const written = await this.storeHistoryImage(store, sessionId, attachmentId, file);
        if (written) return { type: 'image', attachmentId, ...written, ...alt };
      } catch {
        // Fall through to the placeholder: a read that failed is still a
        // picture the transcript is entitled to mention.
      }
      const url = store.urlFor(sessionId, attachmentId, file.mime);
      // With the unstorable-type case answered above, `urlFor` can only refuse
      // here on a malformed id — practically unreachable for derived hex ids,
      // but the honest degradation is the same either way: never a dropped turn.
      if (!url) return unshowableImagePart('An image was produced but could not be saved.');
      return { type: 'image', attachmentId, url, mediaType: file.mime, size: 0, ...alt };
    };
  }

  /**
   * Write a history image the store has never seen, from the `data:` URI
   * OpenCode recorded with it.
   *
   * Only `data:` — a `file://` source would mean reading the disk, which this
   * module may not do (ADR-0308), and an `http(s)` one would mean an outbound
   * request to an address a model chose. Both are handled on the LIVE path in
   * `media-capture.ts`, which is allowed to do I/O; a history read that meets
   * one it cannot decode simply shows no picture rather than pretending.
   */
  private async storeHistoryImage(
    store: SessionAttachmentStore,
    sessionId: string,
    attachmentId: string,
    file: OpenCodeFilePart
  ): Promise<{ url: string; mediaType: string; size: number } | null> {
    const comma = file.url.indexOf(',');
    if (!file.url.startsWith('data:') || comma === -1) return null;
    if (!file.url.slice(5, comma).includes(';base64')) return null;
    // Measured on the ENCODED string, before `Buffer.from` allocates the whole
    // picture just to discover it is too big. Base64 is 4/3 of its payload.
    if (file.url.length - comma - 1 > Math.ceil((MAX_SESSION_ATTACHMENT_BYTES * 4) / 3) + 4) {
      return null;
    }
    return store.put(
      sessionId,
      attachmentId,
      file.mime,
      Buffer.from(file.url.slice(comma + 1), 'base64')
    );
  }

  /**
   * Bind a DorkOS session to an OpenCode session, authoritatively: any stale
   * entry for either key (e.g. a derived adoption that raced the create) is
   * removed so the mapping stays strictly 1:1. The binding writes through to
   * the durable store (same replace-on-either-key semantics) so it survives a
   * server restart (DOR-251); the store contract guarantees the write never
   * throws — a persistence failure degrades to in-memory-only.
   */
  private link(dorkosSessionId: string, openCodeSessionId: string): void {
    const staleOpenCode = this.dorkosToOpenCode.get(dorkosSessionId);
    if (staleOpenCode) this.openCodeToDorkos.delete(staleOpenCode);
    const staleDorkos = this.openCodeToDorkos.get(openCodeSessionId);
    if (staleDorkos) this.dorkosToOpenCode.delete(staleDorkos);
    this.dorkosToOpenCode.set(dorkosSessionId, openCodeSessionId);
    this.openCodeToDorkos.set(openCodeSessionId, dorkosSessionId);
    this.store?.bind(dorkosSessionId, openCodeSessionId);
  }
}
