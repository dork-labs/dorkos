import { clampModeToCeiling, tightensDeclaredMode } from '@dorkos/shared/permission-semantics';
import type { CODEX_CAPABILITIES } from '../runtime-constants.js';
import { logger } from '../../../../lib/logger.js';
import type { Session, HistoryMessage, SessionSettings } from '@dorkos/shared/types';
import type {
  SessionOpts,
  MessageOpts,
  AgentRuntime,
  SessionSettingsPort,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { CodexThreadMap, CodexThreadRecord, CodexThreadMetadataPatch } from '../thread-map.js';
import type { CodexSessionRegistry } from '../session-registry.js';
import type { CodexNativeSessionReader } from '../native-session-reader.js';
import { readLogBackedHistory } from '../../../session/log-backed-history.js';
import {
  getOrCreateProjector,
  peekProjector,
  streamGenerationOf,
} from '../../../session/session-state-projector.js';
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';

interface CodexSessionQueryView {
  readonly CODEX_MODES: NonNullable<typeof CODEX_CAPABILITIES.permissionModes.values>;
  readonly CODEX_DEFAULT_MODE: string;
  readonly settingsPort: SessionSettingsPort | undefined;
  readonly importNativeThread: (sessionId: string, isCurrent?: () => boolean) => Promise<void>;
  readonly maybeWarmMcpStatus: () => void;
  readonly seedDisplayFromDurable: (sessionId: string) => void;
  readonly persistSessionMetadata: (sessionId: string) => void;
  readonly buildDurableSession: (record: CodexThreadRecord) => Promise<Session>;
  readonly toDurableDisplaySession: (record: CodexThreadRecord) => Session;
  readonly toMetadataPatch: (session: Session) => CodexThreadMetadataPatch;
  readonly getCapabilities: AgentRuntime['getCapabilities'];

  readonly threadMap: CodexThreadMap;
  readonly activeTurns: Map<string, AbortController>;
  readonly registry: CodexSessionRegistry;
  readonly nativeSessions: CodexNativeSessionReader;
  readonly hasThreadProof: (sessionId: string) => boolean;
  readonly withNativeSettings: (native: Session) => Session;
  readonly withNativeIdentity: (tracked: Session, native: Session) => Session;
  readonly seedFromDurable: (sessionId: string) => Promise<void>;
  readonly findSession: (sessionId: string) => Promise<Session | null>;
  readonly getMessageHistory: (projectDir: string, sessionId: string) => Promise<HistoryMessage[]>;
}

/** Each external factory owns unrelated query keys; only the runtime keeps its actual registration closure. */
export function createIsolatedCodexSessionQueries() {
  const views = new WeakMap<object, CodexSessionQueryView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): CodexSessionQueryView {
    const view = apply(get, views, [owner]) as CodexSessionQueryView | undefined;
    if (!view) throw new Error('Unknown original Codex session query owner.');
    return view;
  }
  function queryHasThreadProof(owner: object, sessionId: string): boolean {
    const facet = actual(owner);
    return facet.threadMap.get(sessionId) !== undefined || facet.activeTurns.has(sessionId);
  }
  function queryWithNativeSettings(owner: object, native: Session): Session {
    const facet = actual(owner);
    const tracked = facet.registry.get(native.id);
    if (!tracked) return native;
    return {
      ...native,
      permissionMode: tracked.permissionMode,
      ...(tracked.model !== undefined ? { model: tracked.model } : {}),
      ...(tracked.effort !== undefined ? { effort: tracked.effort } : {}),
      ...(tracked.fastMode !== undefined ? { fastMode: tracked.fastMode } : {}),
    };
  }
  function queryWithNativeIdentity(owner: object, tracked: Session, native: Session): Session {
    actual(owner);
    return {
      ...native,
      ...tracked,
      cwd: native.cwd,
      account: native.account,
      createdAt: native.createdAt,
    };
  }
  async function queryListSessions(owner: object, projectDir: string): Promise<Session[]> {
    const facet = actual(owner);
    const native = await facet.nativeSessions.listSessions(projectDir);
    const nativeIds = new Set(native.map((session) => session.id));
    // Explicit ensureSession scopes remain listable for task/relay launch
    // continuity. An imported native row supplies its own identity instead.
    const nativeById = new Map(native.map((session) => [session.id, session]));
    const tracked = facet.registry
      .list(projectDir)
      .filter((session) => facet.hasThreadProof(session.id) || !nativeIds.has(session.id))
      .map((session) =>
        nativeById.has(session.id)
          ? facet.withNativeIdentity(session, nativeById.get(session.id)!)
          : session
      );
    const trackedIds = new Set(tracked.map((session) => session.id));
    const boundNativeIds = new Set(facet.threadMap.listAll().map((row) => row.threadId));
    return [
      ...tracked,
      ...native
        .filter((session) => !boundNativeIds.has(session.id) && !trackedIds.has(session.id))
        .map((session) => facet.withNativeSettings(session)),
    ];
  }
  async function queryGetSession(
    owner: object,
    _projectDir: string,
    sessionId: string
  ): Promise<Session | null> {
    const facet = actual(owner);
    return facet.findSession(sessionId);
  }
  async function queryFindSession(owner: object, sessionId: string): Promise<Session | null> {
    const facet = actual(owner);
    if (facet.hasThreadProof(sessionId)) {
      await facet.seedFromDurable(sessionId);
      const tracked = facet.registry.get(sessionId);
      if (tracked) {
        const binding = facet.threadMap.get(sessionId);
        const native =
          binding?.threadId === sessionId
            ? await facet.nativeSessions.findSession(sessionId)
            : null;
        return native ? facet.withNativeIdentity(tracked, native) : tracked;
      }
    }
    const native = await facet.nativeSessions.findSession(sessionId);
    return native ? facet.withNativeSettings(native) : null;
  }
  async function queryGetMessageHistory(
    owner: object,
    _projectDir: string,
    sessionId: string
  ): Promise<HistoryMessage[]> {
    const facet = actual(owner);
    const log = await readLogBackedHistory(sessionId);
    const binding = facet.threadMap.get(sessionId);
    // DorkOS-created threads keep their log-backed IDs. External native IDs
    // keep their full native transcript, including turns created elsewhere.
    if (binding && binding.threadId !== sessionId) return log;
    const imported =
      binding?.threadId === sessionId ||
      (await facet.nativeSessions.findSession(sessionId)) !== null;
    const native = await facet.nativeSessions.readHistory(sessionId, { required: imported });
    return imported || native.length ? native : log;
  }
  async function queryGetSessionSnapshot(
    owner: object,
    ctx: SessionOpts,
    sessionId: string
  ): Promise<SessionSnapshot> {
    const facet = actual(owner);
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
    return projector.buildSnapshot(() =>
      facet.getMessageHistory(ctx.cwd ?? DEFAULT_CWD, sessionId)
    );
  }
  function querySubscribeSession(
    owner: object,
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    actual(owner);
    return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
      sinceCursor,
      signal
    );
  }
  function queryStreamGeneration(owner: object, _ctx: SessionOpts, sessionId: string): string {
    actual(owner);
    return streamGenerationOf(peekProjector(sessionId));
  }
  function querySubscribeSessionList(
    owner: object,
    _ctx: SessionOpts
  ): AsyncIterable<SessionListEvent> {
    const facet = actual(owner);
    return facet.registry.subscribe();
  }
  function queryEnsureSession(owner: object, sessionId: string, opts: SessionOpts): void {
    const facet = actual(owner);
    // Seed display metadata from the durable row before the register below,
    // so a touch that lands before startup hydration completes cannot mint a
    // fresh blank entry (see seedFromDurable).
    facet.seedDisplayFromDurable(sessionId);
    facet.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    // Pre-warm the MCP-status cache the first time Codex is actually used, so
    // the Agent Profile MCP list is usually populated before the UI's first
    // (synchronous) `getMcpStatus` call instead of empty until a later refetch.
    facet.maybeWarmMcpStatus();
  }

  function queryHasSession(owner: object, sessionId: string): boolean {
    const facet = actual(owner);
    return facet.registry.has(sessionId);
  }

  function queryIsTurnOpen(owner: object, sessionId: string): boolean {
    const facet = actual(owner);
    return facet.activeTurns.has(sessionId);
  }

  async function queryUpdateSession(
    owner: object,
    sessionId: string,
    opts: SessionSettings
  ): Promise<SessionUpdateResult> {
    const facet = actual(owner);
    await facet.seedFromDurable(sessionId);
    if (!facet.hasThreadProof(sessionId)) {
      const native = await facet.nativeSessions.findSession(sessionId);
      if (native) facet.registry.adoptNative(native);
    }
    // Read BEFORE the register below overwrites it — this is the mode the
    // in-flight turn's sandbox was projected from.
    const prevMode = facet.registry.get(sessionId)?.permissionMode ?? facet.CODEX_DEFAULT_MODE;
    await facet.settingsPort?.saveSessionSettings(sessionId, opts);
    facet.registry.register(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
    });
    const pending =
      opts.permissionMode !== undefined &&
      facet.activeTurns.has(sessionId) &&
      tightensDeclaredMode(facet.CODEX_MODES, prevMode, opts.permissionMode);
    return { updated: true, ...(pending ? { permissionModePendingUntilNextTurn: true } : {}) };
  }

  async function queryRenameSession(
    owner: object,
    sessionId: string,
    title: string
  ): Promise<void> {
    const facet = actual(owner);
    // Seed first so the rename lands on top of the durable createdAt/cwd (the
    // user's title is genuinely fresher and overwrites the seeded one).
    await facet.importNativeThread(sessionId);
    await facet.seedFromDurable(sessionId);
    facet.registry.rename(sessionId, title);
    facet.persistSessionMetadata(sessionId);
  }

  async function queryHydrateSessions(owner: object): Promise<void> {
    const facet = actual(owner);
    // The settings joins run concurrently (per-row degradation preserved);
    // Promise.all keeps the records' order for a deterministic hydrate.
    facet.registry.hydrate(
      await Promise.all(
        facet.threadMap.listAll().map((record) => facet.buildDurableSession(record))
      )
    );
  }

  function queryToDurableDisplaySession(owner: object, record: CodexThreadRecord): Session {
    actual(owner);
    return {
      id: record.sessionId,
      title: record.title ?? '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt ?? record.createdAt,
      permissionMode: 'default',
      runtime: 'codex',
      ...(record.lastMessagePreview !== undefined
        ? { lastMessagePreview: record.lastMessagePreview }
        : {}),
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    };
  }

  async function queryBuildDurableSession(
    owner: object,
    record: CodexThreadRecord
  ): Promise<Session> {
    const facet = actual(owner);
    let settings: SessionSettings | null = null;
    try {
      settings = (await facet.settingsPort?.getSessionSettings(record.sessionId)) ?? null;
    } catch (err) {
      // Degrade to defaults rather than dropping the session: the metadata
      // row alone is enough to put it back on the list.
      logger.warn('[CodexRuntime] settings join failed during hydration; using defaults', {
        sessionId: record.sessionId,
        err,
      });
    }
    return {
      ...facet.toDurableDisplaySession(record),
      ...(settings?.permissionMode !== undefined
        ? { permissionMode: settings.permissionMode }
        : {}),
      ...(settings?.model !== undefined ? { model: settings.model } : {}),
      ...(settings?.effort !== undefined ? { effort: settings.effort } : {}),
      ...(settings?.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
    };
  }

  async function querySeedFromDurable(owner: object, sessionId: string): Promise<void> {
    const facet = actual(owner);
    if (facet.registry.has(sessionId)) return;
    const record = facet.threadMap.getRecord(sessionId);
    if (!record) return;
    facet.registry.hydrate([await facet.buildDurableSession(record)]);
  }

  function querySeedDisplayFromDurable(owner: object, sessionId: string): void {
    const facet = actual(owner);
    if (facet.registry.has(sessionId)) return;
    const record = facet.threadMap.getRecord(sessionId);
    if (!record) return;
    facet.registry.hydrate([facet.toDurableDisplaySession(record)]);
  }

  async function queryImportNativeThread(
    owner: object,
    sessionId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const facet = actual(owner);
    if (facet.threadMap.get(sessionId)) return;
    const native = await facet.nativeSessions.findSession(sessionId);
    if (!isCurrent() || !native?.cwd) return;
    facet.registry.adoptNative(native);
    facet.threadMap.setThreadId(sessionId, sessionId, native.cwd, {
      title: native.title,
      updatedAt: native.updatedAt,
    });
  }

  async function queryResolveTurnSettings(
    owner: object,
    sessionId: string,
    opts?: MessageOpts
  ): Promise<SessionSettings> {
    const facet = actual(owner);
    if (!facet.registry.has(sessionId)) {
      const persisted = await facet.settingsPort?.getSessionSettings(sessionId);
      facet.registry.register(sessionId, {
        permissionMode: opts?.permissionMode ?? persisted?.permissionMode ?? 'default',
        ...(persisted?.model !== undefined ? { model: persisted.model } : {}),
        ...(persisted?.effort !== undefined ? { effort: persisted.effort } : {}),
        ...(persisted?.fastMode !== undefined ? { fastMode: persisted.fastMode } : {}),
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    }
    const tracked = facet.registry.get(sessionId)!;
    const model = opts?.model ?? tracked.model;
    const effort = opts?.effort ?? tracked.effort;
    const fastMode = opts?.fastMode ?? tracked.fastMode;
    const chosen = opts?.permissionMode ?? tracked.permissionMode;
    return {
      // Held to the turn's ceiling, for this turn only: a turn another agent's
      // post or a stranger's message started runs no looser than its sender,
      // and the tracked mode is left as the person chose it (spec
      // `trusted-by-default-flip` §4).
      permissionMode:
        opts?.permissionCeiling !== undefined
          ? clampModeToCeiling(
              facet.getCapabilities().permissionModes,
              chosen,
              opts.permissionCeiling
            )
          : chosen,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }

  function queryToMetadataPatch(owner: object, session: Session): CodexThreadMetadataPatch {
    actual(owner);
    return {
      ...(session.title !== '' ? { title: session.title } : {}),
      updatedAt: session.updatedAt,
      ...(session.lastMessagePreview !== undefined
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
    };
  }

  function queryPersistSessionMetadata(owner: object, sessionId: string): void {
    const facet = actual(owner);
    const tracked = facet.registry.get(sessionId);
    if (!tracked) return;
    try {
      facet.threadMap.updateMetadata(sessionId, facet.toMetadataPatch(tracked));
    } catch (err) {
      logger.warn('[CodexRuntime] failed to persist session metadata', { sessionId, err });
    }
  }
  return Object.freeze({
    register(owner: object, view: CodexSessionQueryView): void {
      apply(set, views, [owner, view]);
    },
    queryEnsureSession,
    queryHasSession,
    queryIsTurnOpen,
    queryUpdateSession,
    queryRenameSession,
    queryHydrateSessions,
    queryToDurableDisplaySession,
    queryBuildDurableSession,
    querySeedFromDurable,
    querySeedDisplayFromDurable,
    queryImportNativeThread,
    queryResolveTurnSettings,
    queryToMetadataPatch,
    queryPersistSessionMetadata,

    queryHasThreadProof,
    queryWithNativeSettings,
    queryWithNativeIdentity,
    queryListSessions,
    queryGetSession,
    queryFindSession,
    queryGetMessageHistory,
    queryGetSessionSnapshot,
    querySubscribeSession,
    queryStreamGeneration,
    querySubscribeSessionList,
  });
}
